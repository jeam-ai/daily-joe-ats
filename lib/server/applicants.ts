import {
  activeIntake,
  intakeCapacity,
  INTAKE_QUEUE_LIMIT,
} from "@/lib/data-policy";
import "server-only";
import { formalName } from "@/lib/names";
import { z } from "zod";
import type { Application, User } from "@/types";
import { canManage } from "@/lib/data-policy";
import { transaction, readRecord, putRecord } from "./database";
import { getState, saveState, audit } from "./repository";
import { SafeError } from "./config";
import { purgeDemoApplication } from "./demo";

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
  hiringNeedId: z.string().max(254).optional(),
  notes: z.string().trim().max(10000),
});
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
    if (intakeCapacity(state.applications).full)
      throw new SafeError(
        `Intake capacity is full (${INTAKE_QUEUE_LIMIT} eligible applications). Complete or close an application before adding another.`,
        409,
      );
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
    await saveState(tx, state);
    await audit(tx, user.email, "applicant.created", id, { source: "Manual" });
    await putRecord(tx, "manual_requests", `${user.id}:${values.requestId}`, {
      id,
    });
    return { id };
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
    if (
      !["Hired", "Rejected", "Withdrawn", "Talent Pool"].includes(a.status) &&
      intakeCapacity(state.applications).full
    )
      throw new SafeError(
        "Intake capacity is full. Close an eligible application before restoring this record.",
        409,
      );
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
