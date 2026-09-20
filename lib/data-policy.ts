import type { AppState, Application, User } from "@/types";

export const ACTIVE_APPLICATION_LIMIT = 100;
export const INTAKE_QUEUE_LIMIT = 1000;
export const intakeCapacity = (applications: Application[]) => {
  const retained = applications.filter(eligibleIntake).length;
  return {
    retained,
    available: Math.max(0, INTAKE_QUEUE_LIMIT - retained),
    full: retained >= INTAKE_QUEUE_LIMIT,
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
  eligibleIntake(a) && a.queueState !== "Queued";
export function balanceIntakeWindow(applications: Application[]) {
  const eligible = applications
    .filter(eligibleIntake)
    .sort(
      (a, b) =>
        Date.parse(b.appliedAt) - Date.parse(a.appliedAt) ||
        b.id.localeCompare(a.id),
    );
  const active = new Set(
    eligible.slice(0, ACTIVE_APPLICATION_LIMIT).map((a) => a.id),
  );
  for (const a of applications)
    if (!a.isDemo)
      a.queueState = eligibleIntake(a)
        ? active.has(a.id)
          ? "Active"
          : "Queued"
        : "Closed";
  return {
    active: active.size,
    queued: Math.max(0, eligible.length - ACTIVE_APPLICATION_LIMIT),
  };
}
