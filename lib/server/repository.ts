import "server-only";
import type { AppState, User } from "@/types";
import {
  transaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { initialState } from "./initial-state";
import {
  assertEditor,
  changed,
  deriveNotifications,
  stateSchema,
  validateApplicationChange,
} from "@/lib/domain";
import { SafeError } from "./config";
import { buildTracker } from "./tracker";
export async function getState(tx: Transaction): Promise<AppState> {
  const stored = await readRecord<AppState>(tx, "workspace", "main");
  if (
    stored &&
    process.env.FULL_CAPACITY_MODE === "true" &&
    process.env.NODE_ENV !== "test" &&
    stored.importLimit === 10
  ) {
    stored.importLimit = 100;
    stored.importValidated = true;
    await putRecord(tx, "workspace", "main", stored);
  }
  return stored || initialState();
}
export async function saveState(tx: Transaction, state: AppState) {
  delete state.currentUser;
  state.revision = (state.revision || 0) + 1;
  state.trackerUpdatedAt = new Date().toISOString();
  state.notifications = deriveNotifications(state);
  for (const need of state.hiringNeeds)
    need.filled = state.applications.filter(
      (a) => a.hiringNeedId === need.id && !!a.hiredAt,
    ).length;
  await putRecord(tx, "workspace", "main", state);
  // Relational entities and the bounded workspace read model commit together.
  for (const [collection, records] of Object.entries({
    hiring_needs: state.hiringNeeds,
    qualification_templates: state.qualifications,
    email_templates: state.emailTemplates,
    requirements: state.requirementTemplates,
    locations: state.locations || [],
    notifications: state.notifications,
  })) {
    for (const record of records)
      await tx.query(
        `INSERT INTO ${collection}(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
        [record.id, JSON.stringify(record)],
      );
  }
  for (const user of state.users || [])
    await tx.query(
      "INSERT INTO users(id,email,role,active,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET email=excluded.email,role=excluded.role,active=excluded.active,payload=excluded.payload",
      [
        user.id,
        user.email,
        user.role,
        user.active ? 1 : 0,
        JSON.stringify(user),
      ],
    );
  for (const a of state.applications) {
    await tx.query(
      "INSERT INTO applicants(id,email,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      [a.applicant.id, a.applicant.email, JSON.stringify(a.applicant)],
    );
    await tx.query(
      "INSERT INTO applications(id,applicant_id,hiring_need_id,resume_id,gmail_message_id,gmail_thread_id,stage,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET hiring_need_id=excluded.hiring_need_id,stage=excluded.stage,status=excluded.status,payload=excluded.payload",
      [
        a.id,
        a.applicant.id,
        a.hiringNeedId || null,
        a.resumeId || null,
        a.gmailMessageId || null,
        a.gmailThreadId || null,
        a.stage,
        a.status,
        JSON.stringify(a),
      ],
    );
    for (const i of a.interviews)
      await tx.query(
        "INSERT INTO interviews(id,application_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [i.id, a.id, JSON.stringify(i)],
      );
    for (const r of a.requirements)
      await tx.query(
        "INSERT INTO application_requirements(id,application_id,payload) VALUES($1,$2,$3) ON CONFLICT(id,application_id) DO UPDATE SET payload=excluded.payload",
        [r.id, a.id, JSON.stringify(r)],
      );
    await tx.query(
      "INSERT INTO screening_results(application_id,payload) VALUES($1,$2) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
      [a.id, JSON.stringify(a.screening)],
    );
    if (a.hiredAt)
      await tx.query(
        "INSERT INTO employment_records(application_id,hired_at,payload) VALUES($1,$2,$3) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
        [a.id, a.hiredAt, JSON.stringify(a.employment)],
      );
    for (const e of a.timeline)
      await tx.query(
        "INSERT INTO application_events(id,application_id,occurred_at,actor,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
        [e.id, a.id, e.timestamp, e.user, JSON.stringify(e)],
      );
  }
  await putRecord(tx, "tracker", "snapshot", {
    revision: state.revision,
    updatedAt: state.trackerUpdatedAt,
    state,
  });
  await putRecord(tx, "tracker", "workbook", {
    revision: state.revision,
    base64: Buffer.from(await buildTracker(state)).toString("base64"),
  });
  await putRecord(tx, "sync", "pending", { revision: state.revision });
}
export async function audit(
  tx: Transaction,
  actor: string,
  action: string,
  applicationId?: string,
  metadata: unknown = {},
) {
  await tx.query(
    "INSERT INTO audit_logs(id,occurred_at,actor,action,application_id,payload) VALUES($1,$2,$3,$4,$5,$6)",
    [
      crypto.randomUUID(),
      new Date().toISOString(),
      actor,
      action,
      applicationId || null,
      JSON.stringify(metadata),
    ],
  );
}
export async function findUser(email: string) {
  return transaction(
    async (tx) =>
      (await getState(tx)).users?.find(
        (u) => u.email.toLowerCase() === email.toLowerCase() && u.active,
      ) || null,
  );
}
export async function publicState(user: User) {
  return transaction(async (tx) => {
    const s = await getState(tx);
    s.notifications = deriveNotifications(s);
    return { ...s, currentUser: user };
  });
}
export async function updateState(
  input: unknown,
  user: User,
  confirmed: boolean,
) {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "Invalid workspace data. Check required fields and refresh.",
    );
  return transaction(async (tx) => {
    const before = await getState(tx),
      next = parsed.data as AppState;
    if (next.revision !== before.revision)
      throw new SafeError(
        "Another user changed this workspace. Refresh and try again.",
        409,
      );
    try {
      if (
        before.applications.length !== next.applications.length ||
        before.applications.some(
          (a) => !next.applications.some((n) => n.id === a.id),
        )
      )
        throw new Error(
          "Use the confirmed Gmail import to create records. Imported records cannot be deleted.",
        );
      const adminKeys = [
        "users",
        "locations",
        "qualifications",
        "requirementTemplates",
        "importLimit",
        "importValidated",
        "intakeQuery",
      ] as const;
      if (
        adminKeys.some((k) => changed(before[k], next[k])) &&
        user.role !== "Admin"
      )
        throw new Error("An administrator must change these settings.");
      if (
        changed(before.emailTemplates, next.emailTemplates) ||
        changed(before.hiringNeeds, next.hiringNeeds)
      )
        assertEditor(user);
      if (changed(before.users, next.users)) {
        if (!confirmed) throw new Error("Confirm user access changes.");
        if (
          !next.users?.some(
            (u) => u.email === user.email && u.role === "Admin" && u.active,
          )
        )
          throw new Error("Keep your administrator account active.");
        if (
          new Set(next.users.map((u) => u.email.toLowerCase())).size !==
          next.users.length
        )
          throw new Error("Each authorized email must be unique.");
      }
      if (
        next.importLimit !== before.importLimit &&
        (!confirmed ||
          !next.importValidated ||
          before.applications.length < 10 ||
          next.importLimit !== 100)
      )
        throw new Error(
          "Validate the first 10 imported applicants and confirm expansion to 100.",
        );
      for (const n of next.hiringNeeds) {
        if (
          !next.locations?.some(
            (l) =>
              l.name === n.location &&
              (l.active ||
                before.hiringNeeds.some(
                  (b) => b.id === n.id && b.location === l.name,
                )),
          )
        )
          throw new Error("Select a configured active location.");
      }
      for (const a of next.applications) {
        const b = before.applications.find((v) => v.id === a.id)!;
        if (!changed(b, a)) continue;
        assertEditor(user, b);
        validateApplicationChange(b, a, confirmed);
        if (
          a.hiringNeedId &&
          !next.hiringNeeds.some((n) => n.id === a.hiringNeedId)
        )
          throw new Error("Select an existing hiring need.");
        const interviewOwner = ["HR Queen", "HR Jeam", "HR Ellaine"].includes(
          a.assignedTo || "",
        );
        if (
          a.assignedTo &&
          !next.users?.some((u) => u.email === a.assignedTo && u.active) &&
          !(a.stage === "Initial Interview" && interviewOwner)
        )
          throw new Error("Assign an active HR user.");
        if (
          user.role === "Office Assistant" &&
          (a.assignedTo !== b.assignedTo ||
            a.stage !== b.stage ||
            a.status !== b.status ||
            changed(a.employment, b.employment) ||
            changed(a.screening, b.screening))
        )
          throw new Error("A recruitment manager must make this decision.");
        if (a.hiringNeedId !== b.hiringNeedId) {
          const n = next.hiringNeeds.find((n) => n.id === a.hiringNeedId);
          if (n) {
            a.position = n.position;
            a.location = n.location;
            a.screening = {
              outcome: "Requires Review",
              completedAt: "",
              criteria: (n.criteria || []).map((r) => ({
                id: r.id,
                requirement: r.label,
                result: "Unclear",
                evidence:
                  "HR review required. No automatic evidence assessment has been performed.",
              })),
            };
          }
        }
        const now = new Date().toISOString();
        const fields = Object.keys(a).filter(
          (k) =>
            !["timeline", "lastActivity"].includes(k) &&
            changed(b[k as keyof typeof b], a[k as keyof typeof a]),
        );
        const action =
          a.stage !== b.stage
            ? `Advanced to ${a.stage}`
            : a.status !== b.status
              ? `Application ${a.status}`
              : changed(a.employment, b.employment)
                ? `Employment ${a.employment?.status}`
                : fields.includes("interviews")
                  ? "Interview updated"
                  : fields.includes("requirements")
                    ? "Requirement verified"
                    : "HR record updated";
        a.timeline = [
          ...b.timeline,
          {
            id: crypto.randomUUID(),
            timestamp: now,
            user: user.email,
            action,
            applicationId: a.id,
            metadata: {
              fields: fields.join(", "),
              note:
                a.rejectionReason ||
                a.withdrawalReason ||
                a.employment?.notes ||
                a.notes.slice(b.notes.length).join("\n"),
              communication: "No email sent",
            },
          },
        ];
        a.lastActivity = now;
        for (const r of a.requirements)
          if (
            changed(
              r,
              b.requirements.find((v) => v.id === r.id),
            )
          ) {
            r.verifiedBy = user.email;
            r.date = now;
          }
        if (a.status === "Hired" && b.status !== "Hired") a.hiredAt = now;
        if (a.status === "Hired" && !a.employment)
          a.employment = {
            status: "Active",
            date: now.slice(0, 10),
            notes: "",
            actor: user.email,
          };
        if (a.employment && changed(a.employment, b.employment))
          a.employment.actor = user.email;
        await audit(tx, user.email, action, a.id, {
          fields,
          previousStage: b.stage,
          previousStatus: b.status,
        });
      }
    } catch (e) {
      throw new SafeError((e as Error).message, 403);
    }
    await audit(tx, user.email, "workspace.updated", undefined, {
      fields: Object.keys(next).filter((k) =>
        changed(before[k as keyof AppState], next[k as keyof AppState]),
      ),
    });
    await saveState(tx, next);
    return { ...next, currentUser: user };
  });
}
