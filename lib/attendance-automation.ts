import type { OdooDay, OdooRules } from "./odoo";

export const attendanceSeverities = [
  "Critical",
  "High",
  "Medium",
  "Low",
] as const;
export type AttendanceSeverity = (typeof attendanceSeverities)[number];
export type AttendanceSchedule = "Workday" | "Leave" | "Rest Day" | "Absent";
export function scheduleFromSource(
  value: string,
): AttendanceSchedule | undefined {
  if (/^(?:approved\s+)?leave(?:\s+day)?$/i.test(value.trim())) return "Leave";
  if (/^(?:rest\s+day|day\s+off|off)$/i.test(value.trim())) return "Rest Day";
  if (/^(?:confirmed\s+)?absen(?:t|ce)$/i.test(value.trim())) return "Absent";
  if (/^(?:work(?:ing)?\s*day|scheduled)$/i.test(value.trim()))
    return "Workday";
}
export function durationLabel(minutes: number) {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
/** Odoo hours remain source evidence. Only calculated minute units are rounded. */
export function attendanceCalculation(hours: number | null, rules: OdooRules) {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return undefined;
  const totalMinutes = Math.round(hours * 60);
  const additionalMinutes = Math.max(0, totalMinutes - 540);
  const overtime = totalMinutes > 570;
  const creditedMinutes = overtime
    ? (rules.overtimeRounding === "completed"
        ? Math.floor(additionalMinutes / 60)
        : Math.floor((additionalMinutes + 29) / 60)) * 60
    : 0;
  const remainderMinutes = additionalMinutes % 60;
  const notes = [`${durationLabel(totalMinutes)} recorded.`];
  if (totalMinutes >= 480 && totalMinutes < 540)
    notes.push(
      "Within minimum 8-hour threshold; below standard 9-hour duration.",
    );
  if (additionalMinutes)
    notes.push(
      `${additionalMinutes}m beyond standard 9-hour duration; ${remainderMinutes}m beyond completed attendance hours.`,
    );
  if (overtime)
    notes.push(
      `${Math.max(0, totalMinutes - 570)}m beyond 9h30 normal allowance. Overtime credited: ${creditedMinutes / 60}h (${rules.overtimeRounding === "completed" ? "completed" : "nearest"} whole hours; 30m stays in the lower unit).`,
    );
  return {
    totalMinutes,
    additionalMinutes,
    remainderMinutes,
    creditedMinutes,
    overtime,
    notes,
  };
}
export function attendanceSeverity(record: OdooDay): AttendanceSeverity {
  if (
    ["Resolved", "Payroll Ready", "Approved", "Excused"].includes(
      record.review.status,
    )
  )
    return "Low";
  if (
    record.results.some((r) =>
      /Missing Time|Incomplete|Discrepancy|System Error|Unmatched|Invalid|Review Required/.test(
        r,
      ),
    ) ||
    record.issues.some((i) =>
      /overlap|invalid|no corresponding|multiple pivot/i.test(i),
    )
  )
    return "Critical";
  if (
    record.results.some((r) =>
      /Overtime|Multiple Entries|Schedule Mismatch/.test(r),
    )
  )
    return "High";
  if ((record.lateMinutes ?? 0) > 60 || (record.earlyMinutes ?? 0) > 60)
    return "High";
  if (
    record.results.some((r) =>
      /Late|Early Out|Negative|No Attendance|Unverified/.test(r),
    )
  )
    return "Medium";
  return record.review.status === "For Review" ? "Critical" : "Low";
}
export function refreshAttendanceAutomation(record: OdooDay, rules: OdooRules) {
  const calculation = attendanceCalculation(
    record.attendanceMinutes === undefined
      ? record.worked
      : record.attendanceMinutes / 60,
    rules,
  );
  if (
    calculation &&
    record.attendanceMinutes !== undefined &&
    record.worked !== null &&
    Math.round(record.worked * 60) !== record.attendanceMinutes
  )
    calculation.notes.push(
      `Source worked time: ${durationLabel(Math.round(record.worked * 60))}. Calculated attendance uses the retained clock punches, including recorded breaks.`,
    );
  record.calculation = calculation;
  record.severity = attendanceSeverity(record);
  record.automationReason = [
    ...record.results,
    ...record.issues,
    ...(calculation?.notes || []),
  ].join(" ");
}

export type AttendanceFilters = {
  query?: string;
  status?: string;
  result?: string;
  date?: string;
  department?: string;
  location?: string;
  severity?: string;
  schedule?: string;
  employee?: string;
};
export function matchesAttendance(record: OdooDay, filter: AttendanceFilters) {
  return (
    (!filter.query ||
      `${record.employee} ${record.employeeId || ""}`
        .toLowerCase()
        .includes(filter.query.toLowerCase())) &&
    (!filter.status || record.review.status === filter.status) &&
    (!filter.result ||
      record.results.includes(filter.result) ||
      record.review.classification === filter.result) &&
    (!filter.date || record.date === filter.date) &&
    (!filter.department || record.department === filter.department) &&
    (!filter.location || record.location === filter.location) &&
    (!filter.severity || attendanceSeverity(record) === filter.severity) &&
    (!filter.schedule || record.schedule === filter.schedule) &&
    (!filter.employee ||
      (record.employeeId || record.employee) === filter.employee)
  );
}
