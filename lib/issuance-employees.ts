import type { AppState } from "@/types";
export type IssuanceEmployee = {
  key: string;
  name: string;
  employeeId?: string;
  applicationId?: string;
  position?: string;
  branch?: string;
};
export function issuanceEmployees(state: AppState): IssuanceEmployee[] {
  const people = new Map<string, IssuanceEmployee>();
  const inactive = state.applications.filter(
    (a) => a.employment && a.employment.status !== "Active",
  );
  for (const a of state.applications
    .filter(
      (a) =>
        !a.deletedAt &&
        !a.isDemo &&
        (a.status === "Hired" || a.stage === "Hired" || a.hiredAt) &&
        (!a.employment || a.employment.status === "Active"),
    )
    .sort((a, b) =>
      (a.hiredAt || a.appliedAt).localeCompare(b.hiredAt || b.appliedAt),
    )) {
    const key = `person:${a.applicant.id}`;
    people.set(key, {
      key,
      name: a.applicant.name,
      employeeId: a.applicant.id,
      applicationId: a.id,
      position: a.position,
      branch: a.assignedBranch || a.location,
    });
  }
  for (const r of state.issuance || []) {
    if (
      inactive.some((a) =>
        r.employeeId
          ? a.applicant.id === r.employeeId
          : a.applicant.name.trim().toLowerCase() ===
            r.employeeName.trim().toLowerCase(),
      )
    )
      continue;
    if (
      [...people.values()].some((p) =>
        r.employeeId
          ? p.employeeId === r.employeeId
          : p.name.toLowerCase() === r.employeeName.toLowerCase(),
      )
    )
      continue;
    const key = r.employeeId
      ? `person:${r.employeeId}`
      : `name:${r.employeeName.trim().toLowerCase()}`;
    people.set(key, {
      key,
      name: r.employeeName,
      employeeId: r.employeeId,
      position: r.position,
      branch: r.branch,
    });
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
