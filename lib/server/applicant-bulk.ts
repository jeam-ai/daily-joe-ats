import "server-only";
import { z } from "zod";
import type { Application, User } from "@/types";
import { canManage } from "@/lib/data-policy";
import { transition } from "@/lib/recruitment";
import { validateApplicationChange } from "@/lib/domain";
import {
  qualificationRulesForPosition,
  screenResumeAgainstCriteria,
  buildInsight,
} from "@/lib/screening";
import { unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import { transaction, readRecord, putRecord } from "./database";
import { getState, saveState, audit } from "./repository";
import { filteredApplicationIds } from "./application-list";
import { proceedApplicant } from "./email-outbox";
import { buildTracker } from "./tracker";
import {
  renderEmail,
  emailContext,
  workflowTemplate,
} from "@/lib/email-templates";

const schema = z.object({
  requestId: z.uuid(),
  ids: z.array(z.string()).min(1).max(10000),
  filters: z.string().max(8000),
  allFiltered: z.boolean().default(false),
  revision: z.number().int(),
  action: z.enum([
    "preview",
    "reject",
    "withdraw",
    "talent",
    "status",
    "assign",
    "note",
    "delete",
    "proceed",
    "export",
  ]),
  reason: z.string().trim().max(4000).default(""),
  value: z.string().max(254).default(""),
  scheduledAt: z.string().optional(),
  confirmed: z.literal(true),
  typedConfirmation: z.string().optional(),
});
function checkedTransition(...args: Parameters<typeof transition>) {
  try {
    return transition(...args);
  } catch (error) {
    throw new SafeError(
      error instanceof Error
        ? error.message
        : "Review this recruitment decision.",
    );
  }
}
export async function bulkApplicants(input: unknown, user: User, demo = false) {
  if (!canManage(user))
    throw new SafeError("Recruitment manager access required.", 403);
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new SafeError("Confirm a valid applicant selection and bulk action.");
  const body = parsed.data;
  if (new Set(body.ids).size !== body.ids.length)
    throw new SafeError("Select each applicant once.");
  return transaction(async (tx) => {
    const replay = await readRecord<{ updated: number; emailIds: string[] }>(
      tx,
      "applicant_bulk",
      `${user.email}:${body.requestId}`,
    );
    if (replay) return replay;
    const state = await getState(tx);
    if (state.revision !== body.revision)
      throw new SafeError(
        "The workspace changed. Refresh before applying this bulk action.",
        409,
      );
    const matching = new Set(
      await filteredApplicationIds(tx, new URLSearchParams(body.filters), demo),
    );
    if (
      body.ids.some((id) => !matching.has(id)) ||
      (body.allFiltered && matching.size !== body.ids.length)
    )
      throw new SafeError(
        "The filtered selection changed. Review the results again.",
        409,
      );
    const rows = state.applications.filter(
      (a) => body.ids.includes(a.id) && !a.deletedAt && !!a.isDemo === demo,
    );
    if (rows.length !== body.ids.length)
      throw new SafeError(
        "An applicant is unavailable. Refresh the selection.",
        409,
      );
    if (body.action === "preview")
      return {
        updated: 0,
        emailIds: [],
        preview: rows.map((a) => {
          try {
            const next = transition(a, "Proceed", {
              confirmed: true,
              scheduledAt: body.scheduledAt,
              actor: user.email,
            });
            const template = workflowTemplate(state, next.stage);
            const rendered = template
              ? renderEmail(template, emailContext(next, state, user))
              : undefined;
            return {
              id: a.id,
              name: a.applicant.name,
              recipient: a.applicant.email,
              stage: a.stage,
              nextStage: next.stage,
              subject: rendered?.subject,
              body: rendered?.body,
              error: !template
                ? "Configure the stage email first."
                : rendered?.missing.length
                  ? `Missing template values: ${rendered.missing.join(", ")}`
                  : undefined,
            };
          } catch (e) {
            return {
              id: a.id,
              name: a.applicant.name,
              recipient: a.applicant.email,
              stage: a.stage,
              error: (e as Error).message,
            };
          }
        }),
      };
    if (body.action === "export") {
      if (demo) throw new SafeError("Exit Demo to export real records.", 403);
      const file = await buildTracker({ ...state, applications: rows });
      await audit(tx, user.email, "applications.bulk_exported", undefined, {
        ids: body.ids,
      });
      return { updated: rows.length, emailIds: [], file };
    }
    if (
      body.action === "delete" &&
      body.typedConfirmation !== `DELETE ${rows.length}`
    )
      throw new SafeError(`Type DELETE ${rows.length} to confirm deletion.`);
    if (
      ["reject", "withdraw", "delete", "note"].includes(body.action) &&
      !body.reason
    )
      throw new SafeError("Enter a reason or note for this bulk action.");
    if (["delete", "proceed"].includes(body.action)) {
      const pending = [
        ...(await tx.query(
          "SELECT payload FROM records WHERE collection='email_drafts'",
        )),
        ...(await tx.query(
          "SELECT payload FROM records WHERE collection='email_index'",
        )),
      ];
      if (
        pending.some((r) => {
          const p = JSON.parse(String(r.payload));
          return (
            body.ids.includes(p.applicationId) &&
            ["pending", "Queued", "Sending", "Unconfirmed"].includes(p.status)
          );
        })
      )
        throw new SafeError(
          "Resolve pending email delivery for the selected applicants first.",
          409,
        );
    }
    const now = new Date().toISOString(),
      emailIds: string[] = [];
    for (const a of rows) {
      const before = structuredClone(a);
      let next: Application = structuredClone(a);
      if (body.action === "proceed") {
        // Existing transition gates and outbox are used for every recipient.
        checkedTransition(a, "Proceed", {
          confirmed: true,
          scheduledAt: body.scheduledAt,
          note: body.reason,
          actor: user.email,
        });
        const result = await proceedApplicant(
          a.id,
          {
            expectedStage: a.stage,
            scheduledAt: body.scheduledAt,
            note: body.reason,
            confirmed: true,
          },
          user,
          tx,
          state,
        );
        if (result.emailId) emailIds.push(result.emailId);
        continue;
      }
      if (["reject", "withdraw", "talent"].includes(body.action)) {
        next = checkedTransition(
          a,
          body.action === "reject"
            ? "Reject"
            : body.action === "withdraw"
              ? "Withdraw"
              : "Talent Pool",
          { confirmed: true, note: body.reason, actor: user.email },
        );
        if (body.action === "reject") next.rejectionReason = body.reason;
        if (body.action === "withdraw") next.withdrawalReason = body.reason;
      } else if (body.action === "status") {
        if (
          ![
            "New",
            "For Review",
            "Approved",
            "In Progress",
            "No Response",
          ].includes(body.value)
        )
          throw new SafeError("Choose an active recruitment status.");
        next.status = body.value as Application["status"];
      } else if (body.action === "assign") {
        const need = state.hiringNeeds.find(
          (n) =>
            n.id === body.value && !!n.isDemo === demo && n.status === "Open",
        );
        if (!need)
          throw new SafeError(
            "Choose an open hiring need from this workspace.",
          );
        next.hiringNeedId = need.id;
        next.position = need.position;
        next.location = need.location;
        next.information ||= { fields: {}, conflicts: [] };
        for (const field of ["position", "location"] as const)
          next.information.fields[field] = {
            source: "HR assignment",
            evidence: next[field],
            confidence: "Confident",
            verifiedBy: user.email,
          };
        const rules = qualificationRulesForPosition(
          need.position,
          need.criteria,
          state.qualifications,
        );
        const resume = a.resumeId
          ? (
              await tx.query("SELECT extracted_text FROM resumes WHERE id=$1", [
                a.resumeId,
              ])
            )[0]
          : undefined;
        const text = resume?.extracted_text
          ? unseal<string>(
              String(resume.extracted_text),
              config().encryptionKey,
            )
          : "";
        const criteria = screenResumeAgainstCriteria(
          text,
          rules,
          !!text.trim(),
        );
        next.screening = {
          criteria,
          outcome:
            criteria.length && criteria.every((c) => c.result === "Met")
              ? "Meets Criteria"
              : criteria.some((c) => c.result === "Not Met")
                ? "Criteria Not Met"
                : "Requires Review",
          completedAt: text.trim() ? now : "",
          method: "rules",
          insight: buildInsight(
            criteria,
            need.position,
            need.location,
            !!text.trim(),
          ),
        };
      } else if (body.action === "note") next.notes.push(body.reason);
      else if (body.action === "delete") {
        next.deletedAt = now;
        next.deletedBy = user.email;
        next.deletionReason = body.reason;
      }
      if (body.action !== "delete") validateApplicationChange(a, next, true);
      next.lastActivity = now;
      next.timeline.push({
        id: crypto.randomUUID(),
        timestamp: now,
        user: user.email,
        action: `Bulk applicant action: ${body.action}`,
        applicationId: a.id,
        metadata: {
          note: body.reason,
          previousStatus: a.status,
          value: body.value,
          requestId: body.requestId,
        },
      });
      Object.assign(a, next);
      await audit(tx, user.email, `application.bulk_${body.action}`, a.id, {
        previous: before,
        next: a,
        requestId: body.requestId,
      });
    }
    await saveState(tx, state, { sync: !demo });
    const result = { updated: rows.length, emailIds };
    await putRecord(
      tx,
      "applicant_bulk",
      `${user.email}:${body.requestId}`,
      result,
    );
    return result;
  });
}
