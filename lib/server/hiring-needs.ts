import "server-only";

import { z } from "zod";
import type { Application, HiringNeed, User } from "@/types";
import { canManage } from "@/lib/data-policy";
import { changed, ruleSchema } from "@/lib/domain";
import { SafeError } from "@/lib/server/config";
import {
  putRecord,
  transaction,
  type Transaction,
} from "@/lib/server/database";
import { audit, getState } from "@/lib/server/repository";

const needSchema = z.object({
  id: z.string().min(1).max(254).optional(),
  openedAt: z.string().trim().max(40).optional(),
  position: z.string().trim().min(1).max(10000),
  location: z.string().trim().min(1).max(10000),
  slots: z.number().int().min(1).max(1000),
  urgency: z.enum(["Urgent", "High", "Medium", "Low"]),
  targetDate: z.string().trim().min(1).max(10000),
  status: z.enum(["Open", "Paused", "Filled", "Closed"]),
  criteria: z.array(ruleSchema).max(100).optional(),
  questions: z.string().max(10000),
});

const openingDateSchema = z.object({
  openedAt: z.iso.date(),
  confirmed: z.literal(true),
});

function normalizedOpeningDate(value: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00.000Z`)
    : Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new SafeError("Enter a valid vacancy opening date.");
  return new Date(parsed).toISOString();
}

function resetScreeningForCriteriaChange(
  application: Application,
  need: HiringNeed,
  actor: string,
) {
  const previousScreening = structuredClone(application.screening);
  application.screening = {
    outcome: "Requires Review",
    completedAt: "",
    criteria: (need.criteria || []).map((rule) => ({
      id: rule.id,
      requirement: rule.label,
      result: "Unclear" as const,
      evidence:
        "Hiring-need qualifications changed. Reassess this document against the updated criteria.",
    })),
    insight:
      "Hiring-need qualifications changed. A fresh evidence review is required.",
  };
  application.timeline.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    user: actor,
    action: "Qualification review reset after hiring-need change",
    applicationId: application.id,
    metadata: {
      previous: JSON.stringify(previousScreening),
      next: JSON.stringify(application.screening),
    },
  });
  return previousScreening;
}

/**
 * Do not replay the complete applicant, interview, retention, and issuance
 * projection for a small staffing-plan change. The workspace snapshot remains
 * atomic, while only the hiring need and any deliberately reset screenings
 * are projected. This is the difference between an immediate save and a
 * 10–20 second save on a mature workspace.
 */
async function persistHiringNeedChanges(
  tx: Transaction,
  state: Awaited<ReturnType<typeof getState>>,
  needs: HiringNeed[],
  applications: Application[] = [],
) {
  delete state.currentUser;
  delete state.demoAvailable;
  state.revision = (state.revision || 0) + 1;
  await putRecord(tx, "workspace", "main", state);

  for (const need of needs)
    await tx.query(
      "INSERT INTO hiring_needs(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      [need.id, JSON.stringify(need)],
    );
  for (const application of applications) {
    await tx.query(
      "INSERT INTO applications(id,applicant_id,hiring_need_id,resume_id,gmail_message_id,gmail_thread_id,stage,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET hiring_need_id=excluded.hiring_need_id,resume_id=excluded.resume_id,gmail_message_id=excluded.gmail_message_id,gmail_thread_id=excluded.gmail_thread_id,stage=excluded.stage,status=excluded.status,payload=excluded.payload",
      [
        application.id,
        application.applicant.id,
        application.hiringNeedId || null,
        application.resumeId || null,
        application.gmailMessageId || null,
        application.gmailThreadId || null,
        application.stage,
        application.status,
        JSON.stringify(application),
      ],
    );
    await tx.query(
      "INSERT INTO screening_results(application_id,payload) VALUES($1,$2) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
      [application.id, JSON.stringify(application.screening)],
    );
    const event = application.timeline[application.timeline.length - 1];
    if (event)
      await tx.query(
        "INSERT INTO application_events(id,application_id,occurred_at,actor,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
        [
          event.id,
          application.id,
          event.timestamp,
          event.user,
          JSON.stringify(event),
        ],
      );
  }
  // Cross-device clients poll the workspace revision. This marker also keeps
  // any configured background integration aware of the latest committed edit
  // without waiting for it during the HR action.
  await putRecord(tx, "sync", "pending", { revision: state.revision });
}

/**
 * Hiring needs are operational records, so they are saved as a small,
 * authoritative payload instead of asking the browser to re-submit its entire
 * bounded workspace snapshot. This keeps a stale application elsewhere in the
 * workspace from rejecting an otherwise valid staffing-plan edit.
 */
export async function saveHiringNeed(input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError("A recruitment manager must edit hiring needs.", 403);
  const parsed = needSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "Enter a position, location, valid slots, target date, and hiring status.",
    );
  const values = parsed.data;

  return transaction(async (tx) => {
    const state = await getState(tx);
    const index = values.id
      ? state.hiringNeeds.findIndex((need) => need.id === values.id)
      : -1;
    if (values.id && index < 0)
      throw new SafeError("Hiring need not found.", 404);
    const before =
      index >= 0 ? structuredClone(state.hiringNeeds[index]) : undefined;
    const openedAt = values.openedAt
      ? normalizedOpeningDate(values.openedAt)
      : before?.openedAt || new Date().toISOString();
    const next: HiringNeed = {
      id: before?.id || crypto.randomUUID(),
      isDemo: before?.isDemo,
      openedAt,
      position: values.position,
      location: values.location,
      slots: values.slots,
      filled: before?.filled || 0,
      urgency: values.urgency,
      targetDate: values.targetDate,
      status: values.status,
      qualifications: before?.qualifications || "",
      criteria: values.criteria || before?.criteria || [],
      questions: values.questions,
    };
    if (next.slots < next.filled)
      throw new SafeError("Requested slots cannot be fewer than filled slots.");

    if (before && !changed(before, next)) return structuredClone(before);
    if (index >= 0) state.hiringNeeds[index] = next;
    else state.hiringNeeds.push(next);

    const resetApplications: Application[] = [];
    if (!before || changed(before.criteria, next.criteria)) {
      for (const application of state.applications.filter(
        (item) =>
          item.hiringNeedId === next.id &&
          !item.deletedAt &&
          !!item.isDemo === !!next.isDemo,
      )) {
        const previousScreening = resetScreeningForCriteriaChange(
          application,
          next,
          user.email,
        );
        await audit(
          tx,
          user.email,
          "screening.criteria_changed",
          application.id,
          {
            previous: previousScreening,
            next: application.screening,
          },
        );
        resetApplications.push(application);
      }
    }
    await audit(
      tx,
      user.email,
      before ? "hiring.updated" : "hiring.created",
      undefined,
      { entityType: "hiringNeeds", entityId: next.id, previous: before, next },
    );
    await persistHiringNeedChanges(tx, state, [next], resetApplications);
    return structuredClone(next);
  });
}

export async function setRealHiringNeedsOpeningDate(
  input: unknown,
  user: User,
) {
  if (!canManage(user))
    throw new SafeError("A recruitment manager must edit hiring needs.", 403);
  const parsed = openingDateSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError("Confirm a valid opening date before applying it.");
  const openedAt = normalizedOpeningDate(parsed.data.openedAt);

  return transaction(async (tx) => {
    const state = await getState(tx);
    const affected = state.hiringNeeds.filter(
      (need) => !need.isDemo && need.openedAt !== openedAt,
    );
    if (!affected.length)
      return { updated: 0, hiringNeeds: [] as HiringNeed[] };
    for (const need of affected) need.openedAt = openedAt;
    await audit(tx, user.email, "hiring.open_dates_updated", undefined, {
      openedAt,
      count: affected.length,
      needIds: affected.map((need) => need.id),
    });
    await persistHiringNeedChanges(tx, state, affected);
    return { updated: affected.length, hiringNeeds: structuredClone(affected) };
  });
}

export async function bulkHiringNeeds(input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError("A recruitment manager must edit hiring needs.", 403);
  const body = z
    .object({
      ids: z.array(z.string()).min(1).max(10000),
      revision: z.number().int(),
      filter: z.enum(["Open", "Paused", "Filled", "Closed", "All"]),
      status: z.enum(["Open", "Paused", "Filled", "Closed"]),
      confirmed: z.literal(true),
    })
    .safeParse(input);
  if (!body.success || new Set(body.data.ids).size !== body.data.ids.length)
    throw new SafeError("Confirm the hiring needs and status.");
  return transaction(async (tx) => {
    const state = await getState(tx),
      values = body.data;
    if (state.revision !== values.revision)
      throw new SafeError(
        "The workspace changed. Refresh the selection before confirming.",
        409,
      );
    const rows = state.hiringNeeds.filter(
      (n) =>
        values.ids.includes(n.id) &&
        !n.isDemo &&
        (values.filter === "All" || n.status === values.filter),
    );
    if (rows.length !== values.ids.length)
      throw new SafeError(
        "A selected hiring need no longer matches these filters.",
        409,
      );
    for (const row of rows) {
      const previous = structuredClone(row);
      row.status = values.status;
      await audit(tx, user.email, "hiring.updated", undefined, {
        entityType: "hiringNeeds",
        entityId: row.id,
        previous,
        next: row,
        bulk: true,
      });
    }
    await persistHiringNeedChanges(tx, state, rows);
    return { hiringNeeds: structuredClone(rows) };
  });
}
