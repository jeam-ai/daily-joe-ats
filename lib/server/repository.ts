import { defaultEmailTemplate } from "@/lib/email-templates";
import { unresolved } from "./diagnostics";
import type { DiagnosticIssue } from "@/types/operations";
import { writeAudit } from "./audit";
import "server-only";
import type { AppState, User } from "@/types";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { initialState } from "./initial-state";
import {
  DomainError,
  assertEditor,
  changed,
  deriveNotifications,
  stateSchema,
  validateApplicationChange,
} from "@/lib/domain";
import { SafeError, demoEnabled } from "./config";
import {
  productionState,
  isVisible,
  activeIntake,
  balanceIntakeWindow,
} from "@/lib/data-policy";
import { buildTracker } from "./tracker";
export async function getState(tx: Transaction): Promise<AppState> {
  const stored = await readRecord<AppState>(tx, "workspace", "main");
  // Capacity counts active production applicants; historical records are retained.
  if (stored) stored.importLimit = 100;
  // Migrate the former explicit demo source marker, never a person's name.
  for (const a of stored?.applications || [])
    if (a.source === "Demo") a.isDemo = true;
  if (stored) {
    balanceIntakeWindow(stored.applications);
    // Upgrade only the exact bundled placeholders; preserve authored templates.
    for (const t of stored.emailTemplates) {
      if (
        t.body ===
        "Hello {{applicant_name}},\n\nRegarding your application for {{position}} at {{location}}:\n\n[HR: enter your message before sending.]\n\nDaily Joe Careers"
      )
        Object.assign(t, defaultEmailTemplate(t.name), { id: t.id });
    }
    if (
      !stored.emailTemplates.some(
        (t) => t.name === "Hired" || t.stage === "Hired",
      )
    )
      stored.emailTemplates.push(defaultEmailTemplate("Hired"));
  }
  return stored || initialState();
}
export async function saveState(
  tx: Transaction,
  state: AppState,
  options: { sync?: boolean } = {},
) {
  delete state.currentUser;
  delete state.demoAvailable;
  state.revision = (state.revision || 0) + 1;
  balanceIntakeWindow(state.applications);
  if (options.sync !== false) state.trackerUpdatedAt = new Date().toISOString();
  for (const need of state.hiringNeeds)
    if (options.sync !== false || need.isDemo)
      need.filled = state.applications.filter(
        (a) =>
          a.hiringNeedId === need.id &&
          !!a.hiredAt &&
          !a.deletedAt &&
          !!a.isDemo === !!need.isDemo,
      ).length;
  state.notifications = deriveNotifications(state);
  await putRecord(tx, "workspace", "main", state);
  const statements: { sql: string; values: unknown[] }[] = [];
  const queue = {
    query: async (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
    },
  };
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
      await queue.query(
        `INSERT INTO ${collection}(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
        [record.id, JSON.stringify(record)],
      );
  }
  for (const user of state.users || [])
    await queue.query(
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
    await queue.query(
      "INSERT INTO applicants(id,email,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET email=excluded.email,payload=excluded.payload",
      [a.applicant.id, a.applicant.email, JSON.stringify(a.applicant)],
    );
    await queue.query(
      "INSERT INTO applications(id,applicant_id,hiring_need_id,resume_id,gmail_message_id,gmail_thread_id,stage,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET hiring_need_id=excluded.hiring_need_id,resume_id=excluded.resume_id,gmail_message_id=excluded.gmail_message_id,gmail_thread_id=excluded.gmail_thread_id,stage=excluded.stage,status=excluded.status,payload=excluded.payload",
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
    await queue.query(
      "INSERT INTO intake_window(application_id,state,received_at) VALUES($1,$2,$3) ON CONFLICT(application_id) DO UPDATE SET state=excluded.state,received_at=excluded.received_at",
      [a.id, a.isDemo ? "Demo" : a.queueState || "Closed", a.appliedAt],
    );
    for (const i of a.interviews)
      await queue.query(
        "INSERT INTO interviews(id,application_id,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        [i.id, a.id, JSON.stringify(i)],
      );
    for (const r of a.requirements)
      await queue.query(
        "INSERT INTO application_requirements(id,application_id,payload) VALUES($1,$2,$3) ON CONFLICT(id,application_id) DO UPDATE SET payload=excluded.payload",
        [r.id, a.id, JSON.stringify(r)],
      );
    await queue.query(
      "INSERT INTO screening_results(application_id,payload) VALUES($1,$2) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
      [a.id, JSON.stringify(a.screening)],
    );
    if (a.hiredAt)
      await queue.query(
        "INSERT INTO employment_records(application_id,hired_at,payload) VALUES($1,$2,$3) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
        [a.id, a.hiredAt, JSON.stringify(a.employment)],
      );
    for (const e of a.timeline)
      await queue.query(
        "INSERT INTO application_events(id,application_id,occurred_at,actor,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
        [e.id, a.id, e.timestamp, e.user, JSON.stringify(e)],
      );
  }
  // Group identical upserts into portable multi-row statements. This avoids
  // hundreds of network round trips for one workspace save.
  const groups = new Map<string, unknown[][]>();
  for (const statement of statements)
    groups.set(statement.sql, [
      ...(groups.get(statement.sql) || []),
      statement.values,
    ]);
  for (const [sql, records] of groups) {
    const marker = /VALUES\([^)]*\)/.exec(sql);
    if (!marker) throw new DomainError("Invalid internal upsert statement");
    for (let offset = 0; offset < records.length; offset += 200) {
      const batch = records.slice(offset, offset + 200);
      let parameter = 0;
      const placeholders = batch
        .map(
          (values) => "(" + values.map(() => "$" + ++parameter).join(",") + ")",
        )
        .join(",");
      await tx.query(
        sql.slice(0, marker.index) +
          "VALUES" +
          placeholders +
          sql.slice(marker.index + marker[0].length),
        batch.flat(),
      );
    }
  }
  if (options.sync === false) return;
  const real = productionState(state);
  await putRecord(tx, "tracker", "snapshot", {
    revision: state.revision,
    updatedAt: state.trackerUpdatedAt,
    state: real,
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
  return writeAudit(tx, actor, action, applicationId, metadata);
}
export async function findUser(email: string) {
  return readTransaction(
    async (tx) =>
      (await getState(tx)).users?.find(
        (u) => u.email.toLowerCase() === email.toLowerCase() && u.active,
      ) || null,
  );
}
export async function publicState(user: User) {
  return readTransaction(async (tx) => {
    const s = await getState(tx);
    s.notifications = deriveNotifications(s);
    if (
      user.role === "Admin" ||
      user.role === "HR Generalist" ||
      user.role === "Talent Acquisition"
    ) {
      const issues = (
        await tx.query("SELECT payload FROM records WHERE collection=$1", [
          "diagnostics",
        ])
      ).map((row) => JSON.parse(String(row.payload)) as DiagnosticIssue);
      const readIssues =
        (await readRecord<Record<string, string>>(
          tx,
          "diagnostic_reads",
          user.id,
        )) || {};
      s.notifications.push(
        ...issues
          .filter(
            (i) =>
              unresolved(i) &&
              ["Needs Attention", "Critical"].includes(i.severity),
          )
          .map((i) => ({
            id: `diagnostic-${i.id}`,
            title: i.title,
            description: i.message,
            href: "/settings/diagnostics",
            read: readIssues[i.id] === i.lastAt,
            date: i.lastAt,
          })),
      );
    }
    return visibleState(s, user);
  });
}
export function visibleState(s: AppState, user: User): AppState {
  return {
    ...s,
    applications: s.applications.filter(isVisible),
    currentUser: user,
    demoAvailable: user.role === "Admin" && demoEnabled(),
  };
}
// Preferences are independent of recruitment revisions. Merge only this bounded
// settings payload into the latest state so background intake cannot be lost.
export async function updatePreferences(
  input: unknown,
  user: User,
  intakeQuery?: unknown,
  dataset: "real" | "demo" = "real",
) {
  const parsed = stateSchema.shape.preferences.safeParse(input);
  if (!parsed.success) throw new SafeError("Check your preference selections.");
  if (intakeQuery !== undefined) {
    if (user.role !== "Admin" || dataset !== "real")
      throw new SafeError(
        "Only an administrator in the real workspace can change the Gmail filter.",
        403,
      );
    if (
      typeof intakeQuery !== "string" ||
      !intakeQuery.trim() ||
      intakeQuery.length > 1000
    )
      throw new SafeError(
        "Enter a Gmail search filter of up to 1,000 characters.",
      );
  }
  return transaction(async (tx) => {
    const state = await getState(tx);
    const previous = {
      preferences: state.preferences,
      intakeQuery: state.intakeQuery,
    };
    state.preferences = { ...state.preferences, ...parsed.data };
    if (typeof intakeQuery === "string") state.intakeQuery = intakeQuery.trim();
    await saveState(tx, state, { sync: false });
    await audit(tx, user.email, "preferences.updated", undefined, {
      previous,
      next: { preferences: state.preferences, intakeQuery: state.intakeQuery },
    });
    return visibleState(state, user);
  });
}
export async function updateState(
  input: unknown,
  user: User,
  confirmed: boolean,
  dataset: "real" | "demo" = "real",
) {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "Invalid workspace data. Check required fields and refresh.",
    );
  return transaction(async (tx) => {
    const before = await getState(tx),
      next = parsed.data as AppState;
    for (const records of [
      next.applications,
      next.hiringNeeds,
      next.users || [],
      next.qualifications,
      next.requirementTemplates,
      next.emailTemplates,
      next.locations || [],
    ]) {
      if (new Set(records.map((record) => record.id)).size !== records.length)
        throw new SafeError("Each workspace record must have a unique ID.");
    }
    // Clients may mark existing notifications read; they cannot forge events.
    const incomingRead = new Map(next.notifications.map((n) => [n.id, n.read]));
    // Diagnostic read state is per user and tied to the latest occurrence.
    // Only server-recorded issues can be acknowledged; clients cannot invent them.
    if (["Admin", "HR Generalist", "Talent Acquisition"].includes(user.role)) {
      const readIssues =
        (await readRecord<Record<string, string>>(
          tx,
          "diagnostic_reads",
          user.id,
        )) || {};
      const issues = (
        await tx.query("SELECT payload FROM records WHERE collection=$1", [
          "diagnostics",
        ])
      ).map((row) => JSON.parse(String(row.payload)) as DiagnosticIssue);
      for (const issue of issues) {
        if (incomingRead.get(`diagnostic-${issue.id}`) === true)
          readIssues[issue.id] = issue.lastAt;
      }
      await putRecord(tx, "diagnostic_reads", user.id, readIssues);
    }
    next.notifications = before.notifications.map((n) => ({
      ...n,
      read: incomingRead.get(n.id) ?? n.read,
    }));
    // Window membership is recalculated transactionally, never accepted from a client.
    for (const a of next.applications)
      a.queueState = before.applications.find((b) => b.id === a.id)?.queueState;
    // Archived records never travel to normal views; retain them server-side.
    const archived = before.applications.filter((a) => a.deletedAt);
    if (
      next.applications.some(
        (a) => a.deletedAt || archived.some((b) => b.id === a.id),
      )
    )
      throw new SafeError(
        "Use Data Management to restore archived applicants.",
        403,
      );
    next.applications.push(...archived);
    if (dataset === "demo") {
      const sharedKeys = [
        "users",
        "locations",
        "qualifications",
        "requirementTemplates",
        "emailTemplates",
        "importLimit",
        "importValidated",
        "intakeQuery",
      ] as const;
      const changesRealRecords = (
        ["applications", "hiringNeeds", "notifications"] as const
      ).some((key) =>
        changed(
          before[key].filter((record) => !record.isDemo),
          next[key].filter((record) => !record.isDemo),
        ),
      );
      if (
        changesRealRecords ||
        sharedKeys.some((key) => changed(before[key], next[key]))
      )
        throw new SafeError(
          "Exit Demo to change real records or shared recruitment settings.",
          403,
        );
    }
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
        throw new DomainError(
          "Use Add Applicant, Gmail import, or the confirmed Delete Applicant action.",
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
        throw new DomainError("An administrator must change these settings.");
      if (
        changed(before.emailTemplates, next.emailTemplates) ||
        changed(before.hiringNeeds, next.hiringNeeds)
      )
        assertEditor(user);
      if (changed(before.users, next.users)) {
        if (!confirmed) throw new DomainError("Confirm user access changes.");
        if (
          !next.users?.some(
            (u) => u.email === user.email && u.role === "Admin" && u.active,
          )
        )
          throw new DomainError("Keep your administrator account active.");
        if (
          new Set(next.users.map((u) => u.email.toLowerCase())).size !==
          next.users.length
        )
          throw new DomainError("Each authorized email must be unique.");
      }
      next.importLimit = 100;
      for (const n of next.hiringNeeds) {
        const previous = before.hiringNeeds.find((b) => b.id === n.id);
        if (
          (previous && !!previous.isDemo !== !!n.isDemo) ||
          (!previous && n.isDemo)
        )
          throw new DomainError(
            "Demo records can only be created by Launch Demo.",
          );
        if (
          !n.isDemo &&
          !next.locations?.some(
            (l) =>
              l.name === n.location &&
              (l.active ||
                before.hiringNeeds.some(
                  (b) => b.id === n.id && b.location === l.name,
                )),
          )
        )
          throw new DomainError("Select a configured active location.");
      }
      for (const n of before.hiringNeeds)
        if (!next.hiringNeeds.some((v) => v.id === n.id))
          throw new DomainError(
            "Close hiring needs to retain their recruitment history.",
          );
      for (const a of next.applications) {
        const b = before.applications.find((v) => v.id === a.id)!;
        if (!changed(b, a)) continue;
        assertEditor(user, b);
        validateApplicationChange(b, a, confirmed);
        if (!a.isDemo && a.stage !== b.stage)
          throw new DomainError(
            "Use Proceed to review the stage email and save this transition safely.",
          );
        a.information = structuredClone(
          b.information || { fields: {}, conflicts: [] },
        );
        for (const key of [
          "name",
          "email",
          "phone",
          "location",
          "education",
          "availability",
          "experienceDetails",
          "skills",
          "certifications",
        ] as const) {
          if (a.applicant[key] !== b.applicant[key])
            a.information.fields[key === "location" ? "residence" : key] = {
              source: "HR verified",
              evidence: "Updated by authorized HR",
              confidence: "Confident",
              verifiedBy: user.email,
            };
        }
        for (const key of ["position", "location"] as const)
          if (a[key] !== b[key])
            a.information.fields[key] = {
              source: "HR verified",
              evidence: "Updated by authorized HR",
              confidence: "Confident",
              verifiedBy: user.email,
            };
        if (
          a.hiringNeedId &&
          !next.hiringNeeds.some(
            (n) => n.id === a.hiringNeedId && !!n.isDemo === !!a.isDemo,
          )
        )
          throw new DomainError(
            "Select a hiring need from the same real or demo dataset.",
          );
        if (
          !a.applicant.name.trim() ||
          next.applications.some(
            (v) =>
              v.id !== a.id &&
              v.applicant.email.toLowerCase() ===
                a.applicant.email.toLowerCase(),
          )
        )
          throw new DomainError("Enter a name and a unique applicant email.");
        const interviewOwner = ["HR Queen", "HR Jeam", "HR Ellaine"].includes(
          a.assignedTo || "",
        );
        if (
          a.assignedTo &&
          !next.users?.some((u) => u.email === a.assignedTo && u.active) &&
          !(a.stage === "Initial Interview" && interviewOwner)
        )
          throw new DomainError("Assign an active HR user.");
        if (
          user.role === "Office Assistant" &&
          (a.assignedTo !== b.assignedTo ||
            a.hiringNeedId !== b.hiringNeedId ||
            a.position !== b.position ||
            a.location !== b.location ||
            a.stage !== b.stage ||
            a.status !== b.status ||
            changed(a.employment, b.employment) ||
            changed(a.screening, b.screening))
        )
          throw new DomainError(
            "A recruitment manager must make this decision.",
          );
        if (a.hiringNeedId !== b.hiringNeedId) {
          const n = next.hiringNeeds.find((n) => n.id === a.hiringNeedId);
          if (n) {
            // Recruitment assignment must never rewrite submitted preferences.
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
          } else
            a.screening = {
              outcome: "Requires Review",
              completedAt: "",
              criteria: [],
              insight:
                "Assign a hiring need with configured qualifications before screening.",
            };
        }
        const now = new Date().toISOString();
        const fields = Object.keys(a).filter(
          (k) =>
            !["timeline", "lastActivity"].includes(k) &&
            changed(b[k as keyof typeof b], a[k as keyof typeof a]),
        );
        const action =
          a.stage !== b.stage
            ? `Stage changed: ${b.stage} → ${a.stage}`
            : a.status !== b.status
              ? `Status changed: ${b.status} → ${a.status}`
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
              previous: JSON.stringify(
                Object.fromEntries(
                  fields.map((k) => [k, b[k as keyof typeof b]]),
                ),
              ),
              next: JSON.stringify(
                Object.fromEntries(
                  fields.map((k) => [k, a[k as keyof typeof a]]),
                ),
              ),
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
        await audit(
          tx,
          user.email,
          a.stage !== b.stage
            ? "application.stage_changed"
            : a.status !== b.status
              ? "application.status_changed"
              : fields.includes("screening")
                ? "screening.hr_reviewed"
                : fields.includes("interviews")
                  ? "interview.updated"
                  : fields.includes("requirements")
                    ? "requirement.updated"
                    : "application.edited",
          a.id,
          {
            description: action,
            fields,
            previous: Object.fromEntries(
              fields.map((k) => [k, b[k as keyof typeof b]]),
            ),
            next: Object.fromEntries(
              fields.map((k) => [k, a[k as keyof typeof a]]),
            ),
            previousStage: b.stage,
            previousStatus: b.status,
          },
        );
      }
    } catch (e) {
      if (e instanceof DomainError) throw new SafeError(e.message, 403);
      throw e;
    }
    // A hiring-need criteria edit invalidates earlier evidence for its linked
    // applicants. Never display an old assessment as if it used the new rules.
    for (const need of next.hiringNeeds) {
      const previous = before.hiringNeeds.find((n) => n.id === need.id);
      if (!previous || !changed(previous.criteria, need.criteria)) continue;
      for (const a of next.applications.filter(
        (a) => a.hiringNeedId === need.id && !a.deletedAt,
      )) {
        const previousScreening = a.screening;
        a.screening = {
          outcome: "Requires Review",
          completedAt: "",
          criteria: (need.criteria || []).map((r) => ({
            id: r.id,
            requirement: r.label,
            result: "Unclear",
            evidence:
              "Hiring-need qualifications changed. Reassess this document against the updated criteria.",
          })),
          insight:
            "Hiring-need qualifications changed. A fresh evidence review is required.",
        };
        a.timeline.push({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          user: user.email,
          action: "Qualification review reset after hiring-need change",
          applicationId: a.id,
          metadata: {
            previous: JSON.stringify(previousScreening),
            next: JSON.stringify(a.screening),
          },
        });
        await audit(tx, user.email, "screening.criteria_changed", a.id, {
          previous: previousScreening,
          next: a.screening,
        });
      }
    }
    for (const [collection, module] of [
      ["users", "user"],
      ["hiringNeeds", "hiring"],
      ["qualifications", "settings"],
      ["locations", "settings"],
      ["requirementTemplates", "settings"],
      ["emailTemplates", "settings"],
    ] as const) {
      const oldRecords = before[collection] || [],
        newRecords = next[collection] || [];
      for (const recordId of new Set(
        [...oldRecords, ...newRecords].map((r) => r.id),
      )) {
        const previous = oldRecords.find((r) => r.id === recordId),
          value = newRecords.find((r) => r.id === recordId);
        if (changed(previous, value))
          await audit(
            tx,
            user.email,
            `${module}.${!previous ? "created" : !value ? "removed" : "updated"}`,
            undefined,
            {
              entityType: collection,
              entityId: recordId,
              previous,
              next: value,
            },
          );
      }
    }
    await audit(tx, user.email, "workspace.updated", undefined, {
      fields: Object.keys(next).filter((k) =>
        changed(before[k as keyof AppState], next[k as keyof AppState]),
      ),
    });
    const sync =
      changed(
        productionState(before).applications,
        productionState(next).applications,
      ) ||
      changed(
        productionState(before).hiringNeeds,
        productionState(next).hiringNeeds,
      );
    await saveState(tx, next, { sync });
    return {
      ...visibleState(next, user),
      syncStatus: sync ? "pending" : "unchanged",
    };
  });
}
