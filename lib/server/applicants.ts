import "server-only";
import { formalName } from "@/lib/names";
import { z } from "zod";
import type { Application, ScreeningCriterion, User } from "@/types";
import { canEdit, canManage } from "@/lib/data-policy";
import {
  transaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { getState, saveState, audit } from "./repository";
import { config, SafeError } from "./config";
import { purgeDemoApplication } from "./demo";
import { unseal } from "@/lib/auth/security";
import {
  buildInsight,
  qualificationRulesForPosition,
  screenResumeAgainstCriteria,
} from "@/lib/screening";
import {
  applicationSchema,
  assertEditor,
  changed,
  DomainError,
  validateApplicationChange,
} from "@/lib/domain";

const createSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  firstName: z.string().trim().max(100).optional(),
  middleName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  assignedBranch: z.string().trim().max(200).optional(),
  appliedAt: z.iso.datetime().optional(),
  email: z.email().max(254),
  phone: z.string().trim().max(60),
  position: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(200),
  residence: z.string().trim().max(1000).optional(),
  education: z.string().trim().max(1000).optional(),
  availability: z.string().trim().max(1000).optional(),
  experienceDetails: z.string().trim().max(4000).optional(),
  skills: z.string().trim().max(2000).optional(),
  certifications: z.string().trim().max(2000).optional(),
  hiringNeedId: z.string().max(254).optional(),
  notes: z.string().trim().max(10000),
});
// Profile edits intentionally use a small, field-level payload.  The browser
// workspace is a bounded read model, and an older imported record outside the
// current profile must never prevent HR from correcting this applicant.
const updateSchema = createSchema.omit({ requestId: true });

/**
 * Applicant pages receive a bounded workspace read model.  Saving an
 * applicant through the old workspace PUT consequently made one unrelated,
 * older imported record capable of blocking an otherwise valid HR action.
 * Keep applicant workflow edits small and authoritative instead.
 */
const workflowUpdateSchema = z.object({ application: applicationSchema });

/**
 * A profile form changes one applicant, not the whole recruiting system.
 * Persist its authoritative snapshot and only the projections that this form
 * can affect. Full workspace reconciliation remains available to workflows
 * that actually change stages, retention, or bulk records.
 */
async function persistProfilePatch(
  tx: Transaction,
  state: Awaited<ReturnType<typeof getState>>,
  before: Application,
  application: Application,
) {
  delete state.currentUser;
  delete state.demoAvailable;
  state.revision = (state.revision || 0) + 1;
  await putRecord(tx, "workspace", "main", state);
  if (changed(before.applicant, application.applicant))
    await tx.query(
      "INSERT INTO applicants(id,email,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET email=excluded.email,payload=excluded.payload",
      [
        application.applicant.id,
        application.applicant.email,
        JSON.stringify(application.applicant),
      ],
    );
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
    "INSERT INTO intake_window(application_id,state,received_at) VALUES($1,$2,$3) ON CONFLICT(application_id) DO UPDATE SET state=excluded.state,received_at=excluded.received_at",
    [
      application.id,
      application.isDemo ? "Demo" : application.queueState || "Closed",
      application.appliedAt,
    ],
  );
  if (changed(before.screening, application.screening))
    await tx.query(
      "INSERT INTO screening_results(application_id,payload) VALUES($1,$2) ON CONFLICT(application_id) DO UPDATE SET payload=excluded.payload",
      [application.id, JSON.stringify(application.screening)],
    );
  const priorEventIds = new Set(before.timeline.map((event) => event.id));
  for (const event of application.timeline)
    if (!priorEventIds.has(event.id))
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
  await putRecord(tx, "sync", "pending", { revision: state.revision });
}

export async function updateApplicantWorkflow(
  id: string,
  input: unknown,
  user: User,
  confirmed: boolean,
) {
  const parsed = workflowUpdateSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "This applicant update has invalid fields. Refresh the applicant and try again.",
    );
  const submitted = parsed.data.application as Application;
  if (submitted.id !== id)
    throw new SafeError(
      "The applicant update does not match this profile.",
      409,
    );

  return transaction(async (tx) => {
    const state = await getState(tx);
    const index = state.applications.findIndex(
      (application) => application.id === id && !application.deletedAt,
    );
    if (index < 0) throw new SafeError("Applicant not found.", 404);
    const before = state.applications[index];
    assertEditor(user, before);
    if (!canEdit(user, before))
      throw new SafeError(
        "You do not have permission to update this applicant.",
        403,
      );
    if (!!submitted.isDemo !== !!before.isDemo)
      throw new SafeError(
        "This applicant belongs to a different workspace.",
        409,
      );
    const assignedNeed = submitted.hiringNeedId
      ? state.hiringNeeds.find(
          (need) =>
            need.id === submitted.hiringNeedId &&
            !!need.isDemo === !!before.isDemo,
        )
      : undefined;
    if (submitted.hiringNeedId && !assignedNeed)
      throw new SafeError("Choose a hiring need from the same workspace.", 409);
    // Historical Gmail imports may already contain duplicate addresses. An HR
    // correction that keeps this applicant's email unchanged must remain
    // possible; only reject an edit that tries to *change* it to another
    // applicant's address.
    if (
      before.applicant.email.toLowerCase() !==
        submitted.applicant.email.toLowerCase() &&
      state.applications.some(
        (application) =>
          application.id !== before.id &&
          application.applicant.email.toLowerCase() ===
            submitted.applicant.email.toLowerCase(),
      )
    )
      throw new SafeError("Enter a unique applicant email.");
    if (
      submitted.assignedTo &&
      !state.users?.some(
        (member) => member.email === submitted.assignedTo && member.active,
      )
    )
      throw new SafeError("Assign an active HR user.");
    if (!before.isDemo && submitted.stage !== before.stage)
      throw new DomainError(
        "Use Proceed to review the stage email and save this transition safely.",
      );
    if (
      user.role === "Office Assistant" &&
      [
        "assignedTo",
        "hiringNeedId",
        "position",
        "location",
        "stage",
        "status",
        "employment",
        "screening",
      ].some((field) =>
        changed(
          before[field as keyof Application],
          submitted[field as keyof Application],
        ),
      )
    )
      throw new DomainError(
        "A recruitment manager must make this recruitment decision.",
      );
    validateApplicationChange(before, submitted, confirmed);
    if (!changed(before, submitted)) return structuredClone(before);

    const now = new Date().toISOString();
    const next = structuredClone(submitted);
    if (next.hiringNeedId !== before.hiringNeedId) {
      const rules = qualificationRulesForPosition(
        next.position,
        assignedNeed?.criteria,
        state.qualifications,
      );
      let criteria: ScreeningCriterion[] = rules.map((rule) => ({
        id: rule.id,
        requirement: rule.label,
        result: "Not Assessed" as const,
        evidence:
          "A readable resume is needed before the assigned qualifications can be assessed.",
      }));
      let readable = false;
      if (next.resumeId && rules.length) {
        const resume = (
          await tx.query("SELECT extracted_text FROM resumes WHERE id=$1", [
            next.resumeId,
          ])
        )[0];
        if (resume?.extracted_text) {
          const text = unseal<string>(
            String(resume.extracted_text),
            config().encryptionKey,
          );
          readable = !!text.trim();
          criteria = screenResumeAgainstCriteria(text, rules, readable);
        }
      }
      const outcome =
        !criteria.length ||
        criteria.some(
          (criterion) =>
            criterion.result === "Unclear" ||
            criterion.result === "Not Assessed",
        )
          ? "Requires Review"
          : criteria.some((criterion) => criterion.result === "Not Met")
            ? "Criteria Not Met"
            : "Meets Criteria";
      next.screening = {
        outcome,
        completedAt: readable ? now : "",
        criteria,
        method: readable ? "rules" : undefined,
        insight: buildInsight(criteria, next.position, next.location, readable),
      };
    }
    // Membership and source data are calculated or retained server-side.
    next.queueState = before.queueState;
    next.information = structuredClone(
      before.information || { fields: {}, conflicts: [] },
    );
    for (const key of [
      "name",
      "email",
      "phone",
      "education",
      "availability",
      "experienceDetails",
      "skills",
      "certifications",
      "residence",
      "position",
      "location",
    ] as const) {
      const value =
        key === "position" || key === "location"
          ? next[key]
          : next.applicant[key === "residence" ? "location" : key];
      const prior =
        key === "position" || key === "location"
          ? before[key]
          : before.applicant[key === "residence" ? "location" : key];
      if (value !== prior)
        next.information.fields[key] = {
          source: "HR edit",
          evidence: String(value || ""),
          confidence: "Confident",
          verifiedBy: user.email,
        };
    }
    next.editedBy = user.email;
    next.editedAt = now;
    next.lastActivity = now;
    const fields = Object.keys(next).filter(
      (key) =>
        !["timeline", "lastActivity", "editedAt", "editedBy"].includes(key) &&
        changed(
          before[key as keyof Application],
          next[key as keyof Application],
        ),
    );
    next.timeline = [
      ...before.timeline,
      {
        id: crypto.randomUUID(),
        timestamp: now,
        user: user.email,
        action: fields.includes("screening")
          ? "Qualification screening reviewed"
          : fields.includes("requirements")
            ? "Requirement verified"
            : "HR record updated",
        applicationId: next.id,
        metadata: {
          fields: fields.join(", "),
          communication: "No email sent",
        },
      },
    ];
    state.applications[index] = next;
    await audit(tx, user.email, "application.workflow_updated", id, {
      fields,
      previous: before,
      next,
    });
    // A note, assignee, or ordinary profile correction only needs the edited
    // applicant projection. Replaying all application relationships under the
    // shared workspace lock was making a small manual save wait behind a full
    // tracker reconciliation. Keep the comprehensive path for changes that
    // really alter cross-module relationships.
    const needsFullWorkspaceReconciliation = fields.some((field) =>
      [
        "hiringNeedId",
        "status",
        "stage",
        "hiredAt",
        "employment",
        "requirements",
        "interviews",
      ].includes(field),
    );
    if (needsFullWorkspaceReconciliation)
      await saveState(tx, state, { sync: false });
    else await persistProfilePatch(tx, state, before, next);
    return structuredClone(next);
  });
}

export async function createApplicant(input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError("A recruitment manager must add applicants.", 403);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError("Enter a name, valid email, position, and location.");
  const values = parsed.data;
  return transaction(async (tx) => {
    const previous = await readRecord<{ id: string }>(
      tx,
      "manual_requests",
      `${user.id}:${values.requestId}`,
    );
    if (previous) return previous;
    const state = await getState(tx);
    if (
      state.applications.some(
        (a) => a.applicant.email.toLowerCase() === values.email.toLowerCase(),
      )
    )
      throw new SafeError(
        "An applicant with this email already exists, including archived records. Ask an administrator to restore it if needed.",
        409,
      );
    const need = state.hiringNeeds.find(
      (n) => n.id === values.hiringNeedId && !n.isDemo && n.status === "Open",
    );
    if (values.hiringNeedId && !need)
      throw new SafeError("Choose an open hiring need from real records.");
    const sequence =
      ((await readRecord<number>(tx, "sequence", "applicant")) || 0) + 1;
    await putRecord(tx, "sequence", "applicant", sequence);
    const id = `DJC-${new Date().getFullYear()}-${String(sequence).padStart(5, "0")}`;
    const now = new Date().toISOString();
    const a: Application = {
      id,
      source: "Manual",
      isDemo: false,
      information: {
        fields: Object.fromEntries(
          [
            "name",
            "email",
            "phone",
            "residence",
            "position",
            "location",
            "education",
            "availability",
            "experienceDetails",
            "skills",
            "certifications",
          ]
            .filter((k) => values[k as keyof typeof values])
            .map((k) => [
              k,
              {
                source: "HR verified",
                evidence: "Entered by authorized HR",
                confidence: "Confident" as const,
                verifiedBy: user.email,
              },
            ]),
        ),
        conflicts: [],
      },
      applicant: {
        id: crypto.randomUUID(),
        name: formalName(values.name),
        firstName: values.firstName,
        middleName: values.middleName,
        lastName: values.lastName,
        email: values.email.toLowerCase(),
        phone: values.phone,
        location:
          values.residence ||
          "Residence not confirmed from submitted information.",
        education: values.education,
        availability: values.availability,
        experienceDetails: values.experienceDetails,
        skills: values.skills,
        certifications: values.certifications,
        experience: 0,
      },
      position: values.position,
      location: values.location,
      hiringNeedId: need?.id,
      appliedAt: values.appliedAt || now,
      assignedBranch: values.assignedBranch,
      editedBy: user.email,
      editedAt: now,
      lastActivity: now,
      stage: "Screening",
      status: "New",
      assignedTo: user.email,
      screening: {
        outcome: "Requires Review",
        completedAt: "",
        criteria: (need?.criteria || []).map((r) => ({
          id: r.id,
          requirement: r.label,
          result: "Unclear",
          evidence: "Attach a resume or record verified HR evidence.",
        })),
      },
      notes: values.notes ? [values.notes] : [],
      interviews: [],
      requirements: state.requirementTemplates.map((r) => ({
        ...r,
        status: "Pending",
        notes: "",
      })),
      onboardingStatus: "Pending Orientation",
      timeline: [
        {
          id: crypto.randomUUID(),
          timestamp: now,
          user: user.email,
          action: "Applicant created manually",
          applicationId: id,
          metadata: { communication: "No email sent" },
        },
      ],
    };
    state.applications.push(a);
    // A direct profile patch must not rebuild the entire export/tracker
    // snapshot. The transactional ATS record and workspace revision are the
    // cross-device source of truth.
    await saveState(tx, state, { sync: false });
    await audit(tx, user.email, "applicant.created", id, { source: "Manual" });
    await putRecord(tx, "manual_requests", `${user.id}:${values.requestId}`, {
      id,
    });
    return { id };
  });
}

export async function updateApplicant(id: string, input: unknown, user: User) {
  if (!canManage(user))
    throw new SafeError(
      "A recruitment manager must edit applicant profiles.",
      403,
    );
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success)
    throw new SafeError(
      "Enter a name, valid email, position, and preferred work location.",
    );
  const values = parsed.data;
  return transaction(async (tx) => {
    const state = await getState(tx);
    const application = state.applications.find(
      (item) => item.id === id && !item.deletedAt,
    );
    if (!application) throw new SafeError("Applicant not found.", 404);
    const sameDataset = (needId: string) =>
      state.hiringNeeds.find(
        (need) =>
          need.id === needId &&
          !!need.isDemo === !!application.isDemo &&
          (need.status === "Open" || need.id === application.hiringNeedId),
      );
    const need = values.hiringNeedId
      ? sameDataset(values.hiringNeedId)
      : undefined;
    if (values.hiringNeedId && !need)
      throw new SafeError(
        "Choose an open hiring need from the same workspace.",
      );
    // Historical Gmail imports may already contain duplicate addresses. An HR
    // correction that keeps this applicant's email unchanged must remain
    // possible; only reject an edit that tries to *change* it to another
    // applicant's address.
    if (
      application.applicant.email.toLowerCase() !==
        values.email.toLowerCase() &&
      state.applications.some(
        (item) =>
          item.id !== application.id &&
          item.applicant.email.toLowerCase() === values.email.toLowerCase(),
      )
    )
      throw new SafeError("Enter a unique applicant email.");

    const before = structuredClone(application);
    const now = new Date().toISOString();
    application.position = values.position;
    application.location = values.location;
    application.hiringNeedId = need?.id;
    application.assignedBranch = values.assignedBranch || undefined;
    application.appliedAt = values.appliedAt || application.appliedAt;
    application.applicant = {
      ...application.applicant,
      name:
        application.isDemo && !values.name.startsWith("DEMO — ")
          ? `DEMO — ${formalName(values.name)}`
          : formalName(values.name),
      firstName: values.firstName || undefined,
      middleName: values.middleName || undefined,
      lastName: values.lastName || undefined,
      email: values.email.toLowerCase(),
      phone: values.phone,
      location:
        values.residence ||
        "Residence not confirmed from submitted information.",
      education: values.education || undefined,
      availability: values.availability || undefined,
      experienceDetails: values.experienceDetails || undefined,
      skills: values.skills || undefined,
      certifications: values.certifications || undefined,
    };
    if (values.notes) application.notes.push(values.notes);

    application.information = structuredClone(
      before.information || { fields: {}, conflicts: [] },
    );
    for (const field of [
      "name",
      "firstName",
      "middleName",
      "lastName",
      "email",
      "phone",
      "location",
      "education",
      "availability",
      "experienceDetails",
      "skills",
      "certifications",
    ] as const)
      if (application.applicant[field] !== before.applicant[field])
        application.information.fields[
          field === "location" ? "residence" : field
        ] = {
          source: "HR verified",
          evidence: "Updated by authorized HR",
          confidence: "Confident",
          verifiedBy: user.email,
        };
    for (const field of ["position", "location"] as const)
      if (application[field] !== before[field])
        application.information.fields[field] = {
          source: "HR verified",
          evidence: "Updated by authorized HR",
          confidence: "Confident",
          verifiedBy: user.email,
        };

    if (application.hiringNeedId !== before.hiringNeedId)
      application.screening = need
        ? {
            outcome: "Requires Review",
            completedAt: "",
            criteria: (need.criteria || []).map((rule) => ({
              id: rule.id,
              requirement: rule.label,
              result: "Unclear",
              evidence:
                "HR review required after the hiring-need assignment changed.",
            })),
          }
        : {
            outcome: "Requires Review",
            completedAt: "",
            criteria: [],
            insight:
              "Assign a hiring need with configured qualifications before screening.",
          };

    const changedFields = [
      "applicant",
      "position",
      "location",
      "hiringNeedId",
      "assignedBranch",
      "appliedAt",
      "screening",
      "notes",
    ].filter(
      (field) =>
        JSON.stringify(before[field as keyof Application]) !==
        JSON.stringify(application[field as keyof Application]),
    );
    if (!changedFields.length) return structuredClone(application);
    application.editedBy = user.email;
    application.editedAt = now;
    application.lastActivity = now;
    application.timeline.push({
      id: crypto.randomUUID(),
      timestamp: now,
      user: user.email,
      action: "HR record updated",
      applicationId: application.id,
      metadata: {
        fields: changedFields.join(", "),
        note: values.notes || "",
        communication: "No email sent",
      },
    });
    await audit(tx, user.email, "application.edited", application.id, {
      fields: changedFields,
      previous: before,
      next: application,
    });
    await persistProfilePatch(tx, state, before, application);
    return structuredClone(application);
  });
}

export async function deleteApplicant(
  id: string,
  input: { confirmed?: boolean; typedId?: string; reason?: string },
  user: User,
) {
  if (!canManage(user))
    throw new SafeError("A recruitment manager must delete applicants.", 403);
  if (input.confirmed !== true)
    throw new SafeError("Confirm Delete Applicant first.");
  return transaction(async (tx) => {
    const state = await getState(tx);
    const a = state.applications.find((a) => a.id === id && !a.deletedAt);
    if (!a) throw new SafeError("Applicant not found or already deleted.", 404);
    if (!a.isDemo && input.typedId !== a.id)
      throw new SafeError("Type the applicant ID exactly to confirm deletion.");
    const pending = await tx.query(
      "SELECT payload FROM records WHERE collection=$1",
      ["email_drafts"],
    );
    if (
      pending.some((r) => {
        const draft = JSON.parse(String(r.payload));
        return draft.applicationId === id && draft.status === "pending";
      })
    )
      throw new SafeError(
        "An email send is pending. Check its delivery before deleting this applicant.",
        409,
      );
    const mailIndex = await tx.query(
      "SELECT payload FROM records WHERE collection=$1",
      ["email_index"],
    );
    if (
      mailIndex.some((r) => {
        const m = JSON.parse(String(r.payload));
        return (
          m.applicationId === id &&
          ["Queued", "Sending", "Unconfirmed"].includes(m.status)
        );
      })
    )
      throw new SafeError(
        "Resolve pending email delivery before deleting this applicant.",
        409,
      );
    if (a.isDemo) {
      await purgeDemoApplication(tx, a);
      state.applications = state.applications.filter((v) => v.id !== id);
    } else {
      a.deletedAt = new Date().toISOString();
      a.deletedBy = user.email;
      a.deletionReason = (input.reason || "Deleted by HR").slice(0, 2000);
      a.timeline.push({
        id: crypto.randomUUID(),
        timestamp: a.deletedAt,
        user: user.email,
        action: "Applicant soft deleted",
        applicationId: id,
        metadata: { note: a.deletionReason },
      });
    }
    await audit(
      tx,
      user.email,
      a.isDemo ? "demo.applicant.deleted" : "applicant.soft_deleted",
      id,
      { reason: a.deletionReason || "Demo removal", previousStatus: a.status },
    );
    await saveState(tx, state, { sync: !a.isDemo });
    return {
      isDemo: !!a.isDemo,
      message: a.isDemo
        ? "Demo applicant deleted successfully."
        : "Applicant deleted successfully. An administrator can restore the record.",
    };
  });
}

export async function restoreApplicant(id: string, user: User) {
  if (user.role !== "Admin")
    throw new SafeError("Administrator access required.", 403);
  return transaction(async (tx) => {
    const state = await getState(tx);
    const a = state.applications.find(
      (a) => a.id === id && a.deletedAt && !a.isDemo,
    );
    if (!a) throw new SafeError("Archived applicant not found.", 404);
    delete a.deletedAt;
    delete a.deletedBy;
    delete a.deletionReason;
    a.timeline.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      user: user.email,
      action: "Applicant restored",
      applicationId: id,
      metadata: {},
    });
    await saveState(tx, state);
    await audit(tx, user.email, "applicant.restored", id);
    return { message: "Applicant restored successfully." };
  });
}
