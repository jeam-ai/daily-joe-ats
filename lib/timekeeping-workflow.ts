import type { OdooDay } from "./odoo";

export type TimekeepingQueueGroupId =
  | "missing-time-out"
  | "missing-time-in"
  | "negative-attendance"
  | "excessive-overtime"
  | "no-attendance"
  | "duplicate-records"
  | "data-errors"
  | "other";

export type TimekeepingQueueGroup = {
  id: TimekeepingQueueGroupId;
  label: string;
  records: OdooDay[];
  description: string;
};

const normalResults = new Set(["Normal", "Rest Day / Day Off"]);

export const needsClassification = (record: OdooDay) =>
  (record.results.includes("Negative Attendance") ||
    record.results.includes("No Attendance")) &&
  !record.review.classification;

export const needsAction = (record: OdooDay) =>
  record.review.status === "For Review" || needsClassification(record);

export const awaitsVerification = (record: OdooDay) =>
  !needsAction(record) &&
  (record.review.status === "Corrected" ||
    (record.review.correctedInOdoo === true &&
      record.review.status !== "Payroll Ready"));

const groupDefinitions: Omit<TimekeepingQueueGroup, "records">[] = [
  {
    id: "missing-time-out",
    label: "Missing time-out",
    description:
      "A clock-out is missing. Confirm the reason or record an Odoo correction.",
  },
  {
    id: "missing-time-in",
    label: "Missing time-in",
    description:
      "A clock-in is missing. Confirm the reason or record an Odoo correction.",
  },
  {
    id: "negative-attendance",
    label: "Negative attendance",
    description:
      "HR chooses whether the variance is late, undertime, or early out.",
  },
  {
    id: "excessive-overtime",
    label: "Excessive overtime",
    description:
      "14+ recorded hours require HR verification; this is not assumed to be valid overtime.",
  },
  {
    id: "no-attendance",
    label: "No attendance",
    description:
      "No source attendance is not automatically an absence. HR confirms the reason.",
  },
  {
    id: "duplicate-records",
    label: "Duplicate or conflicting records",
    description:
      "Multiple source rows are retained for HR comparison; none are deleted automatically.",
  },
  {
    id: "data-errors",
    label: "Data or import errors",
    description:
      "The source needs verification before this day can be used for payroll.",
  },
  {
    id: "other",
    label: "Other unresolved exceptions",
    description:
      "This record needs an HR decision before the cutoff can be completed.",
  },
];

const isInGroup = (record: OdooDay, id: TimekeepingQueueGroupId) => {
  const result = record.results;
  if (id === "missing-time-out") return result.includes("Missing Time Out");
  if (id === "missing-time-in") return result.includes("Missing Time In");
  if (id === "negative-attendance")
    return result.includes("Negative Attendance");
  if (id === "excessive-overtime") return result.includes("Excessive Overtime");
  if (id === "no-attendance") return result.includes("No Attendance");
  if (id === "duplicate-records") return result.includes("Multiple Entries");
  if (id === "data-errors")
    return result.some((item) =>
      /Incomplete|Discrepancy|System Error|Review Required/i.test(item),
    );
  return true;
};

export function queueGroups(records: OdooDay[]): TimekeepingQueueGroup[] {
  const active = records.filter(needsAction);
  const assigned = new Set<string>();
  return groupDefinitions.map((definition) => {
    const matches = active.filter((record) => {
      if (definition.id === "other") return !assigned.has(record.id);
      const matched = isInGroup(record, definition.id);
      if (matched) assigned.add(record.id);
      return matched;
    });
    return { ...definition, records: matches };
  });
}

export function queueGroupFilter(id: TimekeepingQueueGroupId) {
  return (
    {
      "missing-time-out": "Missing Time Out",
      "missing-time-in": "Missing Time In",
      "negative-attendance": "Negative Attendance",
      "excessive-overtime": "Excessive Overtime",
      "no-attendance": "No Attendance",
      "duplicate-records": "Multiple Entries",
      "data-errors": "Incomplete Attendance",
      other: "",
    } satisfies Record<TimekeepingQueueGroupId, string>
  )[id];
}

export function issueExplanation(record: OdooDay, excessiveHours = 14) {
  if (record.results.includes("Excessive Overtime"))
    return `Recorded attendance is ${record.worked ?? "unavailable"} hours. ${excessiveHours}+ hours is flagged for HR verification; a missing punch is possible, but not assumed.`;
  if (record.results.includes("Missing Time Out"))
    return "A clock-out was not present in the uploaded Attendance report. Verify the source or track an Odoo correction.";
  if (record.results.includes("Missing Time In"))
    return "A clock-in was not present in the uploaded Attendance report. Verify the source or track an Odoo correction.";
  if (record.results.includes("Negative Attendance"))
    return "The worked-versus-expected variance is negative. The source cannot tell whether it was late, undertime, or early out.";
  if (record.results.includes("No Attendance"))
    return "There is no attendance source row for this cutoff date. HR must decide the reason; it is not automatically an absence.";
  if (record.results.includes("Multiple Entries"))
    return "More than one Attendance row applies to this employee and date. Review the source rows before resolving it.";
  return (
    record.issues[0] ||
    "This record needs HR review before the cutoff is ready."
  );
}

export function employeeAttendanceSummary(records: OdooDay[]) {
  const unresolved = records.filter(needsAction);
  const awaiting = records.filter(awaitsVerification);
  const exceptions = records.filter(
    (record) =>
      record.issues.length > 0 ||
      record.results.some((result) => !normalResults.has(result)),
  );
  return {
    cutoffDays: records.length,
    recordedDays: records.filter((record) => record.raw.length > 0).length,
    normalDays: records.filter((record) =>
      record.results.every((result) => normalResults.has(result)),
    ).length,
    exceptions: exceptions.length,
    resolved: exceptions.filter(
      (record) => !needsAction(record) && !awaitsVerification(record),
    ).length,
    unresolved: unresolved.length,
    clarification: unresolved.filter(needsClassification).length,
    awaitingVerification: awaiting.length,
  };
}

export function cutoffWorkflow(records: OdooDay[]) {
  const groups = queueGroups(records);
  const actionRequired = records.filter(needsAction);
  const awaitingVerification = records.filter(awaitsVerification);
  const automaticallyCleared = records.filter(
    (record) =>
      !needsAction(record) &&
      !awaitsVerification(record) &&
      record.review.history.length === 0,
  );
  const completed = records.filter(
    (record) => !needsAction(record) && !awaitsVerification(record),
  );
  const remaining = actionRequired.length + awaitingVerification.length;
  return {
    groups,
    actionRequired,
    awaitingVerification,
    automaticallyCleared,
    completed,
    remaining,
    progress: records.length
      ? Math.round((completed.length / records.length) * 100)
      : 0,
  };
}
