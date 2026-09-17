import type { Application, Stage } from "@/types";
export const stages: Stage[] = [
  "Screening",
  "Initial Interview",
  "Final Interview",
  "Requirements",
  "Onboarding",
  "Hired",
];
export type Decision =
  "Proceed" | "Review" | "Reject" | "Talent Pool" | "Withdraw";
export function nextStage(application: Application): Stage {
  return stages[
    Math.min(stages.indexOf(application.stage) + 1, stages.length - 1)
  ];
}
export function transition(
  application: Application,
  decision: Decision,
  options: {
    confirmed: boolean;
    scheduledAt?: string;
    note?: string;
    actor?: string;
  },
): Application {
  if (!options.confirmed)
    throw new Error("Confirm the decision before saving.");
  if (
    ["Hired", "Rejected", "Withdrawn", "Talent Pool"].includes(
      application.status,
    )
  )
    throw new Error("This application is closed.");
  const next = nextStage(application);
  if (
    decision === "Proceed" &&
    application.stage.includes("Interview") &&
    !application.interviews.some(
      (i) => i.stage === application.stage && i.status === "Passed",
    )
  )
    throw new Error("Record a passed interview before proceeding.");
  const now = new Date().toISOString();
  if (
    decision === "Proceed" &&
    next.includes("Interview") &&
    (!options.scheduledAt ||
      !Number.isFinite(new Date(options.scheduledAt).getTime()) ||
      new Date(options.scheduledAt).getTime() <= Date.now())
  )
    throw new Error("Choose a future interview date and time.");
  if (
    decision === "Proceed" &&
    ["Onboarding", "Hired"].includes(next) &&
    application.requirements.some((r) => r.status !== "Complete")
  )
    throw new Error("Verify all requirements before proceeding.");
  if (
    decision === "Proceed" &&
    next === "Hired" &&
    application.onboardingStatus !== "Completed"
  )
    throw new Error(
      "Complete onboarding before marking the applicant as hired.",
    );
  const result: Application = {
    ...application,
    lastActivity: now,
    notes: options.note
      ? [...application.notes, options.note]
      : application.notes,
    timeline: [
      ...application.timeline,
      {
        id: crypto.randomUUID(),
        timestamp: now,
        user: options.actor || "HR",
        action:
          decision === "Proceed"
            ? `Advanced to ${next}`
            : decision === "Reject"
              ? "Applicant rejected"
              : decision === "Review"
                ? "Flagged for HR review"
                : decision === "Withdraw"
                  ? "Application withdrawn"
                  : "Added to talent pool",
        applicationId: application.id,
        metadata: {
          previousStage: application.stage,
          decision,
          note: options.note || "",
          communication: "No email sent",
        },
      },
    ],
  };
  if (decision === "Proceed") {
    result.stage = next;
    result.status = next === "Hired" ? "Hired" : "In Progress";
    if (next === "Hired") result.hiredAt = now;
    if (next.includes("Interview"))
      result.interviews = [
        ...result.interviews,
        {
          id: crypto.randomUUID(),
          stage: next as "Initial Interview" | "Final Interview",
          scheduledAt: options.scheduledAt!,
          status: "Scheduled",
          notes: "",
        },
      ];
  } else if (decision === "Review") result.status = "For Review";
  else if (decision === "Reject") result.status = "Rejected";
  else if (decision === "Withdraw") result.status = "Withdrawn";
  else {
    result.status = "Talent Pool";
    result.talentPoolAddedAt = now;
  }
  return result;
}
export function renderTemplate(text: string, values: Record<string, string>) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}
export function isActive(a: Application) {
  return !["Hired", "Rejected", "Withdrawn", "Talent Pool"].includes(a.status);
}
