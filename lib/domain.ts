export class DomainError extends Error {}
import { z } from "zod";
import type { AppState, Application, User } from "@/types";
import { stages } from "./recruitment";
const text = z.string().max(10000);
const id = z.string().min(1).max(254);
export const ruleSchema = z.object({
  id,
  label: text,
  kind: z.enum(["Minimum", "Preferred"]),
  absenceFails: z.boolean(),
});
export const userSchema = z.object({
  id,
  email: z.email(),
  name: text,
  role: z.enum([
    "Admin",
    "Talent Acquisition",
    "HR Generalist",
    "Office Assistant",
    "Viewer",
  ]),
  title: text,
  active: z.boolean(),
  avatarUrl: z.url().max(500).optional(),
});
export const applicationSchema = z.object({
  assignedBranch: text.optional(),
  editedBy: text.optional(),
  editedAt: z.iso.datetime().optional(),
  queueState: z.enum(["Active", "Queued", "Closed"]).optional(),
  information: z
    .object({
      fields: z.record(
        z.string(),
        z.object({
          source: text,
          evidence: text,
          confidence: z.enum(["Confident", "Uncertain", "Missing"]),
          verifiedBy: text.optional(),
        }),
      ),
      conflicts: z.array(text),
    })
    .optional(),
  isDemo: z.boolean().optional(),
  deletedAt: text.optional(),
  deletedBy: text.optional(),
  deletionReason: text.optional(),
  extraction: z
    .object({
      method: z.enum(["text", "ocr", "mixed"]),
      confidence: z.number().min(0).max(100).optional(),
      pages: z.number().optional(),
      textVersion: z.string().max(100).optional(),
      warnings: z.array(text),
    })
    .optional(),
  id,
  applicant: z.object({
    id,
    name: text,
    firstName: text.optional(),
    middleName: text.optional(),
    lastName: text.optional(),
    email: z.email(),
    phone: text,
    location: text,
    experience: z.number().min(0).max(100),
    availability: text.optional(),
    education: text.optional(),
    experienceDetails: text.optional(),
    skills: text.optional(),
    certifications: text.optional(),
  }),
  position: text,
  location: text,
  appliedAt: z.iso.datetime(),
  stage: z.enum(stages as [string, ...string[]]),
  status: z.enum([
    "New",
    "For Review",
    "Approved",
    "In Progress",
    "Hired",
    "Rejected",
    "Withdrawn",
    "No Response",
    "Talent Pool",
  ]),
  screening: z.object({
    outcome: z.enum(["Meets Criteria", "Requires Review", "Criteria Not Met"]),
    criteria: z
      .array(
        z.object({
          id,
          requirement: text,
          result: z.enum(["Met", "Unclear", "Not Met", "Not Assessed"]),
          evidence: text,
        }),
      )
      .max(100),
    completedAt: text,
    insight: text.optional(),
    method: z.enum(["rules", "ai", "hr", "demo"]).optional(),
    evidence: z.array(text).optional(),
  }),
  lastActivity: text,
  notes: z.array(text).max(1000),
  interviews: z
    .array(
      z.object({
        id,
        stage: z.enum(["Initial Interview", "Final Interview"]),
        scheduledAt: z.iso.datetime(),
        status: z.enum([
          "Scheduled",
          "Confirmed",
          "Attended",
          "No-show",
          "Passed",
          "Failed",
        ]),
        notes: text,
      }),
    )
    .max(100),
  requirements: z
    .array(
      z.object({
        id,
        name: text,
        status: z.enum(["Complete", "Pending", "Needs Correction"]),
        verifiedBy: text.optional(),
        date: text.optional(),
        notes: text,
      }),
    )
    .max(100),
  timeline: z
    .array(
      z.object({
        id,
        timestamp: text,
        user: text,
        action: text,
        applicationId: text.optional(),
        metadata: z.record(z.string(), z.string()),
      }),
    )
    .max(10000),
  gmailMessageId: text.optional(),
  gmailThreadId: text.optional(),
  hiredAt: text.optional(),
  talentPoolAddedAt: text.optional(),
  orientationDate: text.optional(),
  commitmentDate: text.optional(),
  onboardingStatus: z.enum(["Pending Orientation", "Scheduled", "Completed"]),
  hiringNeedId: text.optional(),
  resumeId: text.optional(),
  resumeHash: text.optional(),
  source: text.optional(),
  originalSubject: text.optional(),
  rfcMessageId: text.optional(),
  assignedTo: text.optional(),
  rejectionReason: text.optional(),
  withdrawalReason: text.optional(),
  employment: z
    .object({
      status: z.enum(["Active", "Resigned", "Terminated"]),
      date: text,
      notes: text,
      actor: text,
    })
    .optional(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  revision: z.number().optional(),
  users: z.array(userSchema).max(100).optional(),
  currentUser: userSchema.optional(),
  locations: z
    .array(
      z.object({
        id,
        name: text,
        city: text,
        province: text,
        active: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
  importLimit: z.number().int().min(10).max(100).optional(),
  importValidated: z.boolean().optional(),
  intakeQuery: text.optional(),
  intakePaused: z.boolean().optional(),
  trackerUpdatedAt: text.optional(),
  syncStatus: text.optional(),
  applications: z.array(applicationSchema).max(10000),
  hiringNeeds: z
    .array(
      z.object({
        id,
        position: text,
        isDemo: z.boolean().optional(),
        location: text,
        slots: z.number().int().min(1).max(1000),
        filled: z.number().int().min(0),
        urgency: z.enum(["Urgent", "High", "Medium", "Low"]),
        targetDate: text,
        status: z.enum(["Open", "Paused", "Filled", "Closed"]),
        qualifications: text,
        questions: text,
        criteria: z.array(ruleSchema).max(100).optional(),
      }),
    )
    .max(100),
  qualifications: z
    .array(
      z.object({
        id,
        position: text,
        minimum: text,
        preferred: text,
        criteria: text,
        questions: text,
        rules: z.array(ruleSchema).max(100).optional(),
      }),
    )
    .max(100),
  requirementTemplates: z.array(z.object({ id, name: text })).max(100),
  emailTemplates: z
    .array(
      z.object({
        id,
        name: text,
        subject: text,
        body: text,
        stage: z.enum(stages as [string, ...string[]]).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
  notifications: z
    .array(
      z.object({
        id,
        title: text,
        description: text,
        href: text,
        read: z.boolean(),
        date: text,
        isDemo: z.boolean().optional(),
      }),
    )
    .max(1000),
  preferences: z.object({
    compact: z.boolean(),
    weekStartsMonday: z.boolean(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    timezone: z.enum(["Asia/Manila", "Asia/Singapore", "UTC"]).optional(),
    dateFormat: z.enum(["en-PH", "en-US"]).optional(),
    notifications: z.boolean().optional(),
  }),
});
// Schema parsing can reorder object keys. Compare values independently of
// insertion order so a preference save cannot edit every applicant or sync it.
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export const changed = (a: unknown, b: unknown) =>
  canonicalJson(a) !== canonicalJson(b);
export function assertEditor(user: User, application?: Application) {
  if (user.role === "Viewer")
    throw new DomainError("Your account has read-only access.");
  if (
    user.role === "Office Assistant" &&
    (!application || application.assignedTo !== user.email)
  )
    throw new DomainError(
      "This action requires an assigned application or a recruitment manager.",
    );
}
export function validateApplicationChange(
  before: Application,
  after: Application,
  confirmed: boolean,
) {
  for (const key of [
    "id",
    "isDemo",
    "deletedAt",
    "deletedBy",
    "deletionReason",
    "extraction",
    "gmailMessageId",
    "gmailThreadId",
    "resumeId",
    "resumeHash",
    "source",
    "originalSubject",
    "rfcMessageId",
  ] as const)
    if (changed(before[key], after[key]))
      throw new DomainError(
        "Imported identity and source history cannot be overwritten.",
      );
  if (before.applicant.id !== after.applicant.id)
    throw new DomainError("Applicant identity cannot be replaced.");
  if (before.hiredAt && after.hiredAt !== before.hiredAt)
    throw new DomainError("The original hired date must be preserved.");
  if (after.hiredAt && after.status !== "Hired")
    throw new DomainError("A hired date can only be recorded after hiring.");
  if (
    before.hiringNeedId === after.hiringNeedId &&
    changed(
      before.screening.criteria.map((c) => [c.id, c.requirement]),
      after.screening.criteria.map((c) => [c.id, c.requirement]),
    )
  )
    throw new DomainError("Screening must use the assigned HR criteria.");
  if (before.notes.some((note, i) => after.notes[i] !== note))
    throw new DomainError("Historical HR notes cannot be removed.");
  if (
    before.interviews.some((i) => !after.interviews.some((n) => n.id === i.id))
  )
    throw new DomainError("Interview history must be retained.");
  if (
    before.requirements.some(
      (i) =>
        !after.requirements.some((n) => n.id === i.id && n.name === i.name),
    )
  )
    throw new DomainError("Historical requirements must be retained.");
  const consequence = [
    "status",
    "stage",
    "interviews",
    "onboardingStatus",
    "employment",
  ].some((k) =>
    changed(before[k as keyof Application], after[k as keyof Application]),
  );
  if (consequence && !confirmed)
    throw new DomainError("Confirm this consequential action before saving.");
  if (
    ["Rejected", "Withdrawn", "Talent Pool", "Hired"].includes(before.status) &&
    (after.status !== before.status || after.stage !== before.stage)
  )
    throw new DomainError("Closed application history cannot be changed.");
  if (before.stage !== after.stage) {
    if (stages.indexOf(after.stage) !== stages.indexOf(before.stage) + 1)
      throw new DomainError("Complete each recruitment stage in order.");
    if (
      before.stage.includes("Interview") &&
      !before.interviews.some(
        (i) => i.stage === before.stage && i.status === "Passed",
      )
    )
      throw new DomainError("Record a passed interview before proceeding.");
    if (
      after.stage.includes("Interview") &&
      !after.interviews.some(
        (i) =>
          i.stage === after.stage &&
          i.status === "Scheduled" &&
          new Date(i.scheduledAt).getTime() > Date.now(),
      )
    )
      throw new DomainError("Schedule a future interview before proceeding.");
  }
  if (after.status === "Hired" && after.stage !== "Hired")
    throw new DomainError("Complete the hiring stages first.");
  if (
    ["Onboarding", "Hired"].includes(after.stage) &&
    after.requirements.some((r) => r.status !== "Complete")
  )
    throw new DomainError("Verify all requirements first.");
  if (
    after.stage === "Hired" &&
    (after.onboardingStatus !== "Completed" || !after.hiredAt)
  )
    throw new DomainError("Complete onboarding before hiring.");
  if (
    after.onboardingStatus !== "Pending Orientation" &&
    (!after.orientationDate || !after.commitmentDate)
  )
    throw new DomainError("Set orientation and commitment dates.");
  if (after.employment && after.status !== "Hired")
    throw new DomainError("Employment updates require a hired applicant.");
  if (
    after.employment &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(after.employment.date) ||
      !Number.isFinite(Date.parse(after.employment.date)))
  )
    throw new DomainError("Enter a valid employment effective date.");
}
export function deriveNotifications(state: AppState) {
  const read = new Set(
    state.notifications.filter((n) => n.read).map((n) => n.id),
  );
  const result: AppState["notifications"] = state.notifications
    .filter((n) => n.id.startsWith("timekeeping-"))
    .slice(-30);
  const add = (
    id: string,
    title: string,
    description: string,
    href: string,
    date: string,
  ) => result.push({ id, title, description, href, date, read: read.has(id) });
  for (const a of state.applications) {
    if (a.deletedAt) continue;
    if (a.source === "Gmail" && !a.isDemo)
      add(
        `new-${a.id}`,
        "New Application Received",
        `${a.applicant.name} · ${a.position} · ${a.location} · ${a.screening.criteria.length ? `${a.screening.criteria.filter((c) => c.result === "Met").length} of ${a.screening.criteria.length} qualifications appear met` : "Assign a hiring need to review qualifications"} · HR review required`,
        `/applications/${a.id}`,
        a.timeline.find((e) => e.action === "Application imported from Gmail")
          ?.timestamp || a.appliedAt,
      );
    if (["Rejected", "Withdrawn", "Hired", "Talent Pool"].includes(a.status))
      continue;
    const href = `/applications/${a.id}`;
    if (["New", "For Review"].includes(a.status) && a.source !== "Gmail")
      add(
        `review-${a.id}`,
        "Application needs review",
        `${a.applicant.name} · ${a.position}`,
        href,
        a.appliedAt,
      );
    for (const i of a.interviews) {
      const diff = Date.parse(i.scheduledAt) - Date.now();
      if (
        ["Scheduled", "Confirmed", "Attended"].includes(i.status) &&
        diff < 86400000
      )
        add(
          `interview-${i.id}`,
          diff < 0
            ? "Interview decision required"
            : "Interview within 24 hours",
          a.applicant.name,
          href,
          i.scheduledAt,
        );
    }
    if (
      a.stage === "Requirements" &&
      a.requirements.some((r) => r.status !== "Complete")
    )
      add(
        `requirements-${a.id}`,
        "Incomplete requirements",
        a.applicant.name,
        href,
        a.lastActivity,
      );
    const lastEmail = [...a.timeline]
      .reverse()
      .find((e) => e.action === "Email sent");
    if (
      lastEmail &&
      Date.now() - Date.parse(lastEmail.timestamp) > 172800000 &&
      Date.parse(a.lastActivity) <= Date.parse(lastEmail.timestamp)
    )
      add(
        `response-${lastEmail.id}`,
        "Response check due",
        `${a.applicant.name} · Check Gmail replies; never automatically rejected.`,
        href,
        lastEmail.timestamp,
      );
  }
  for (const n of state.hiringNeeds)
    if (
      ["Urgent", "High"].includes(n.urgency) &&
      n.status === "Open" &&
      n.filled < n.slots
    )
      add(
        `need-${n.id}`,
        "Urgent hiring need underfilled",
        `${n.position} · ${n.location}`,
        `/hiring-needs?edit=${n.id}`,
        n.targetDate,
      );
  return result.map((notification) => ({
    ...notification,
    isDemo:
      state.applications.some(
        (a) => a.isDemo && notification.href === `/applications/${a.id}`,
      ) ||
      state.hiringNeeds.some(
        (n) => n.isDemo && notification.id === `need-${n.id}`,
      ),
  }));
}
