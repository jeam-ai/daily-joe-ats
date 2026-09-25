import type { AppState, Application, User } from "@/types";

export const ACTIVE_APPLICATION_LIMIT = 100;
// The dashboard emphasizes a small working window, while the live recruitment
// queue retains the newest 500. Gmail intake is intentionally never capped.
export const INTAKE_QUEUE_LIMIT = 500;
export const intakeCapacity = (applications: Application[]) => {
  const retained = Math.min(
    applications.filter(eligibleIntake).length,
    INTAKE_QUEUE_LIMIT,
  );
  return {
    retained,
    // Kept for existing callers. This is informational only: a full live
    // queue moves older records into retention; it never stops Gmail intake.
    available: Math.max(0, INTAKE_QUEUE_LIMIT - retained),
    full: false,
  };
};

export const isDemo = (record: { isDemo?: boolean }) => record.isDemo === true;
export const isVisible = (a: Application) => !a.deletedAt;
export const canManage = (user?: User) =>
  !!user &&
  ["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role);
export const canEdit = (user: User | undefined, a: Application) =>
  canManage(user) ||
  (user?.role === "Office Assistant" && a.assignedTo === user.email);
export function productionState(state: AppState): AppState {
  return {
    ...state,
    applications: state.applications.filter((a) => !isDemo(a) && isVisible(a)),
    hiringNeeds: state.hiringNeeds.filter((n) => !isDemo(n)),
    notifications: state.notifications.filter((n) => !n.isDemo),
  };
}

export const eligibleIntake = (a: Application) =>
  !a.isDemo &&
  !a.deletedAt &&
  !["Hired", "Rejected", "Withdrawn", "Talent Pool"].includes(a.status) &&
  a.stage !== "Hired";

export const activeIntake = (a: Application) =>
  eligibleIntake(a) &&
  (a.queueState === undefined || a.queueState === "Active");
export function balanceIntakeWindow(applications: Application[]) {
  const eligible = applications
    .filter(eligibleIntake)
    .sort(
      (a, b) =>
        Date.parse(b.appliedAt) - Date.parse(a.appliedAt) ||
        b.id.localeCompare(a.id),
    );
  const live = new Set(eligible.slice(0, INTAKE_QUEUE_LIMIT).map((a) => a.id));
  const active = new Set(
    eligible.slice(0, ACTIVE_APPLICATION_LIMIT).map((a) => a.id),
  );
  for (const a of applications)
    if (!a.isDemo)
      a.queueState = eligibleIntake(a)
        ? active.has(a.id)
          ? "Active"
          : live.has(a.id)
            ? "Queued"
            : "Closed"
        : "Closed";
  return {
    active: active.size,
    queued: Math.max(
      0,
      Math.min(eligible.length, INTAKE_QUEUE_LIMIT) - ACTIVE_APPLICATION_LIMIT,
    ),
  };
}
