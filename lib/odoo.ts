import { attendanceTimestamp, defaultAttendanceRules } from "./timekeeping";
import {
  attendanceCalculation,
  refreshAttendanceAutomation,
  scheduleFromSource,
  type AttendanceSchedule,
  type AttendanceSeverity,
} from "./attendance-automation";
export const ODOO_ANALYSIS_VERSION = 7;

export type OdooCell = string | number | null;
export type OdooMatrix = OdooCell[][];
export type OdooSource = {
  filename: string;
  sheet: string;
  hash: string;
  rows: number;
};
export type RawAttendance = {
  schedule?: AttendanceSchedule;
  date?: string;
  row: number;
  employee: string;
  employeeId?: string;
  department?: string;
  location?: string;
  checkIn: string;
  checkOut: string;
  worked: number | null;
  overtime: number | null;
  extra: number | null;
};
export type PivotDay = {
  schedule?: AttendanceSchedule;
  row: number;
  employee: string;
  date: string;
  worked: number | null;
  expected: number | null;
  difference: number | null;
  balance: number | null;
};
export type OdooReports = {
  attendance: RawAttendance[];
  pivot: PivotDay[];
  sources: OdooSource[];
  period: { start: string; end: string; title: string };
  warnings: string[];
  aliases: { source: string; candidate: string }[];
};
export type OdooRules = {
  overtimeRounding?: "nearest" | "completed";
  timezone: "Asia/Manila" | "Asia/Singapore" | "UTC";
  start: string;
  end: string;
  graceMinutes: number;
  overtimeMinutes: number;
  excessiveWorkedHours?: number;
  discrepancyMinutes: number;
  expectedHours: number | null;
  workDays: number[];
};
export const defaultOdooRules: OdooRules = {
  timezone: "Asia/Manila",
  start: "",
  end: "",
  graceMinutes: 0,
  overtimeMinutes: 30,
  overtimeRounding: "nearest",
  excessiveWorkedHours: 16,
  discrepancyMinutes: 1,
  expectedHours: null,
  workDays: [],
};
export const reviewStatuses = [
  "For Review",
  "Resolved",
  "Approved",
  "Excused",
  "Corrected",
  "Payroll Ready",
] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];
export const attendanceClassifications = [
  "Late",
  "Undertime",
  "Early Out",
  "Absent",
  "Day Off",
  "Leave",
  "System / Data Issue",
  "Other",
] as const;
export type AttendanceClassification =
  (typeof attendanceClassifications)[number];
export type OdooReview = {
  status: ReviewStatus;
  // Classification answers what happened. Status is the separate HR
  // resolution workflow; source data alone may not choose a classification.
  classification?: AttendanceClassification;
  correctedInOdoo?: boolean;
  correctionNote?: string;
  duplicateResolution?: {
    retainedSourceRows: number[];
    disregardedSourceRows: number[];
    disregardedRecords?: RawAttendance[];
    retainedRecords?: RawAttendance[];
  };
  note: string;
  reviewer: string;
  reviewedAt: string;
  history: {
    previous: ReviewStatus;
    next: ReviewStatus;
    reviewer: string;
    timestamp: string;
    note: string;
  }[];
};
export type OdooDay = {
  attendanceMinutes?: number;
  schedule?: AttendanceSchedule;
  severity?: AttendanceSeverity;
  calculation?: ReturnType<typeof attendanceCalculation>;
  automationReason?: string;
  id: string;
  employee: string;
  employeeId?: string;
  sourceNames: string[];
  department: string;
  location: string;
  date: string;
  checkIn: string;
  checkOut: string;
  rawWorked: number | null;
  pivotWorked: number | null;
  worked: number | null;
  expected: number | null;
  difference: number | null;
  pivotDifference: number | null;
  balance: number | null;
  overtime: number | null;
  extra: number | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  results: string[];
  issues: string[];
  raw: RawAttendance[];
  pivot: PivotDay[];
  review: OdooReview;
};
export type OdooAnalysis = {
  version: number;
  rules: OdooRules;
  aliases: Record<string, string>;
  period: OdooReports["period"];
  sources: OdooSource[];
  warnings: string[];
  records: OdooDay[];
};
export function isZeroExpectedHoursSystemIssue(record: OdooDay) {
  return (
    record.expected === 0 &&
    record.worked !== null &&
    record.worked > 0 &&
    record.raw.length === 1 &&
    record.results.every((result) =>
      [
        "System Error — Expected hours missing or zero",
        "Overtime",
        "Normal",
      ].includes(result),
    )
  );
}
const clean = (v: OdooCell | undefined) => String(v ?? "").trim();
const header = (v: OdooCell | undefined) =>
  clean(v)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export const employeeKey = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
function number(v: OdooCell | undefined): number | null {
  if (v === null || v === undefined || clean(v) === "") return null;
  const n = typeof v === "number" ? v : Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
const column = (row: OdooCell[], names: string[]) =>
  row.findIndex((v) => names.includes(header(v)));
const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
export function odooDate(value: string): string | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(text);
  const named = /^(\d{1,2})[ -]([A-Za-z]+)[ ,\-]+(\d{4})$/.exec(text);
  const result = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : named && months.includes(named[2].slice(0, 3).toLowerCase())
      ? `${named[3]}-${String(months.indexOf(named[2].slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${named[1].padStart(2, "0")}`
      : null;
  return result &&
    !Number.isNaN(Date.parse(result)) &&
    new Date(result).toISOString().slice(0, 10) === result
    ? result
    : null;
}
export function parseOdooReports(
  raw: OdooMatrix,
  pivot: OdooMatrix,
  sources: OdooSource[],
): OdooReports {
  const h = raw
    .slice(0, 20)
    .findIndex(
      (row) =>
        column(row, ["employee", "employeename"]) >= 0 &&
        column(row, ["checkin", "timein"]) >= 0,
    );
  if (h < 0)
    throw Error(
      "We couldn't read the Attendance report. Employee, Check In and Check Out columns are required.",
    );
  const cols = {
    employee: column(raw[h], ["employee", "employeename"]),
    checkIn: column(raw[h], ["checkin", "timein"]),
    checkOut: column(raw[h], ["checkout", "timeout"]),
    worked: column(raw[h], ["workedhours", "hoursworked"]),
    overtime: column(raw[h], ["overtime", "overtimehours"]),
    extra: column(raw[h], ["extrahours"]),
    employeeId: column(raw[h], ["employeeid", "employeeexternalid"]),
    department: column(raw[h], ["department"]),
    location: column(raw[h], ["location", "branch"]),
    schedule: column(raw[h], ["schedule", "daytype", "attendancestatus"]),
    date: column(raw[h], ["date", "workdate"]),
  };
  if (
    [cols.checkOut, cols.worked, cols.overtime, cols.extra].some((v) => v < 0)
  )
    throw Error(
      "The Attendance report needs Check Out, Worked Hours, Over Time and Extra Hours. Export the complete Odoo Attendance report.",
    );
  const attendance: RawAttendance[] = [];
  const warnings: string[] = [];
  raw.slice(h + 1).forEach((row, i) => {
    if (!row.some((v) => clean(v))) return;
    const employee =
      clean(row[cols.employee]) || `Unmatched employee (row ${h + i + 2})`;
    if (!clean(row[cols.employee])) {
      warnings.push(
        `Attendance row ${h + i + 2} has no employee name and needs correction.`,
      );
    }
    attendance.push({
      row: h + i + 2,
      employee,
      checkIn: clean(row[cols.checkIn]),
      checkOut: clean(row[cols.checkOut]),
      worked: number(row[cols.worked]),
      overtime: number(row[cols.overtime]),
      extra: number(row[cols.extra]),
      employeeId: clean(row[cols.employeeId]) || undefined,
      department: clean(row[cols.department]) || undefined,
      location: clean(row[cols.location]) || undefined,
      schedule: scheduleFromSource(clean(row[cols.schedule])),
      date: odooDate(clean(row[cols.date])) || undefined,
    });
  });
  const ph = pivot
    .slice(0, 20)
    .findIndex(
      (row) =>
        column(row, ["workedhours"]) >= 0 &&
        column(row, ["expectedhours"]) >= 0,
    );
  if (ph < 0)
    throw Error(
      "We couldn't read the Pivot Worked Hours report. The Worked Hours / Expected Hours structure could not be detected.",
    );
  const pc = {
    worked: column(pivot[ph], ["workedhours"]),
    expected: column(pivot[ph], ["expectedhours"]),
    difference: column(pivot[ph], ["difference"]),
    balance: column(pivot[ph], ["balance"]),
    schedule: column(pivot[ph], ["schedule", "daytype", "attendancestatus"]),
  };
  if (pc.difference < 0 || pc.balance < 0)
    throw Error(
      "The Pivot report needs Difference and Balance columns. Export the full Worked Hours view.",
    );
  const days: PivotDay[] = [];
  let employee = "";
  pivot.slice(ph + 1).forEach((row, i) => {
    const label = clean(row[0]);
    if (!label || /^(grand )?total$/i.test(label)) return;
    const date = odooDate(label);
    if (date) {
      if (!employee)
        throw Error(
          `Pivot row ${ph + i + 2} has a date without an employee heading.`,
        );
      days.push({
        row: ph + i + 2,
        employee,
        date,
        worked: number(row[pc.worked]),
        expected: number(row[pc.expected]),
        difference: number(row[pc.difference]),
        balance: number(row[pc.balance]),
        schedule: scheduleFromSource(clean(row[pc.schedule])),
      });
    } else {
      if (/^\d/.test(label))
        throw Error(
          `Pivot row ${ph + i + 2} has an unreadable date. Use the original Odoo date labels.`,
        );
      employee = label;
    }
  });
  if (!attendance.length || !days.length)
    throw Error(
      "Both reports need readable employee attendance records and daily Pivot rows.",
    );
  // Check-out can cross midnight. The reporting period belongs to work dates.
  const workDates = [
    ...days.map((r) => r.date),
    ...attendance
      .map((r) => r.date || odooDate(r.checkIn) || odooDate(r.checkOut))
      .filter((d): d is string => !!d),
  ].sort();
  const start = workDates[0],
    end = workDates.at(-1)!;
  if (Date.parse(end) - Date.parse(start) > 93 * 86400000)
    throw Error("Choose reports covering no more than 93 days per analysis.");
  const rawDates = attendance
      .map((r) => r.date || odooDate(r.checkIn) || odooDate(r.checkOut))
      .filter((v): v is string => !!v)
      .sort(),
    pivotDates = days.map((r) => r.date).sort();
  if (
    rawDates.length &&
    (rawDates[0] > pivotDates.at(-1)! || rawDates.at(-1)! < pivotDates[0])
  )
    throw Error(
      "These reports cover different dates. Upload Attendance and Pivot Worked Hours for the same cutoff.",
    );
  if (
    rawDates.length &&
    (rawDates[0] !== pivotDates[0] || rawDates.at(-1) !== pivotDates.at(-1)!)
  )
    warnings.push(
      "The report date ranges differ. Unmatched dates are included for HR review; confirm the selected cutoff.",
    );
  const names = [
    ...new Set([
      ...attendance.map((r) => r.employee),
      ...days.map((r) => r.employee),
    ]),
  ];
  const aliases = names.flatMap((source) => {
    const base = source.replace(/\s+\(\d+\)$/, ""),
      candidate = names.find(
        (n) => n !== source && employeeKey(n) === employeeKey(base),
      );
    return candidate ? [{ source, candidate }] : [];
  });
  const title =
    pivot
      .slice(0, ph)
      .flat()
      .map(clean)
      .find((v) => /^[A-Za-z]+ \d{4}$/.test(v)) || "Odoo attendance";
  if (!attendance.some((r) => r.employeeId))
    warnings.push(
      "Employee IDs are not included. Exact normalized names are matched; numbered name variants require HR confirmation.",
    );
  if (!attendance.some((r) => r.location || r.department))
    warnings.push("Department and branch are not included in these reports.");
  return {
    attendance,
    pivot: days,
    sources,
    period: { start, end, title },
    warnings,
    aliases,
  };
}
const total = (values: (number | null)[]) =>
  values.length && values.every((v) => v !== null)
    ? values.reduce<number>((sum, v) => sum + v!, 0)
    : null;
function* analyzeOdooSteps(
  reports: OdooReports,
  rules: OdooRules,
  aliases: Record<string, string> = {},
): Generator<{ processed: number; total: number }, OdooAnalysis> {
  const stamp = (value: string) =>
    attendanceTimestamp(value, {
      ...defaultAttendanceRules,
      dateOrder: "ISO",
      timezone: rules.timezone,
    });
  const names = [
    ...new Set([
      ...reports.attendance.map((r) => r.employee),
      ...reports.pivot.map((r) => r.employee),
    ]),
  ];
  for (const [source, target] of Object.entries(aliases))
    if (!names.includes(source) || !names.includes(target) || aliases[target])
      throw Error(
        "Choose an existing employee for each identity mapping. Chained mappings are not supported.",
      );
  const groups = new Map<
    string,
    {
      name: string;
      names: Set<string>;
      raw: RawAttendance[];
      pivot: PivotDay[];
    }
  >();
  const byName = new Map<string, string[]>();
  for (const row of reports.attendance)
    if (row.employeeId)
      byName.set(employeeKey(row.employee), [
        ...new Set([
          ...(byName.get(employeeKey(row.employee)) || []),
          row.employeeId,
        ]),
      ]);
  function group(name: string, id?: string) {
    const canonical = aliases[name] || name,
      ids = byName.get(employeeKey(canonical)) || [];
    const key = id
      ? `id:${id}`
      : ids.length === 1
        ? `id:${ids[0]}`
        : `name:${employeeKey(canonical)}`;
    if (!groups.has(key))
      groups.set(key, {
        name: canonical,
        names: new Set(),
        raw: [],
        pivot: [],
      });
    const g = groups.get(key)!;
    g.names.add(name);
    return g;
  }
  reports.attendance.forEach((r) =>
    group(r.employee, aliases[r.employee] ? undefined : r.employeeId).raw.push(
      r,
    ),
  );
  reports.pivot.forEach((r) => group(r.employee).pivot.push(r));
  const records: OdooDay[] = [];
  const dates: string[] = [];
  for (
    let d = Date.parse(reports.period.start);
    d <= Date.parse(reports.period.end);
    d += 86400000
  )
    dates.push(new Date(d).toISOString().slice(0, 10));
  for (const [key, g] of groups) {
    const undated = g.raw.filter(
      (r) => !r.date && !odooDate(r.checkIn) && !odooDate(r.checkOut),
    );
    const days = undated.length ? [...dates, "Unknown date"] : dates;
    for (const date of days) {
      if (records.length % 200 === 0)
        yield { processed: records.length, total: groups.size * days.length };
      const raw = g.raw.filter(
          (r) =>
            (r.date ||
              odooDate(r.checkIn) ||
              odooDate(r.checkOut) ||
              "Unknown date") === date,
        ),
        pivot = g.pivot.filter((r) => r.date === date),
        results: string[] = [],
        issues: string[] = [];
      const rawWorked = total(raw.map((r) => r.worked)),
        pivotWorked = total(pivot.map((r) => r.worked));
      const worked = raw.length ? rawWorked : pivotWorked;
      let expected = pivot.length === 1 ? pivot[0].expected : null;
      // Odoo formula results can retain sub-microsecond floating-point residue.
      // Normalize only the calculated expectation; preserve the original row.
      if (expected !== null && Math.abs(expected) < 1e-9) expected = 0;
      if (pivot.length > 1)
        issues.push(
          "Multiple Pivot rows: expected hours require HR verification.",
        );
      if (
        expected === null &&
        rules.expectedHours !== null &&
        date !== "Unknown date" &&
        rules.workDays.includes(new Date(date).getUTCDay())
      )
        expected = rules.expectedHours;
      if (expected === null && raw.length && pivot.length === 1) expected = 9;
      const overtime = total(raw.map((r) => r.overtime)),
        extra = total(raw.map((r) => r.extra));
      const difference =
        worked !== null && expected !== null ? worked - expected : null;
      const instants = raw.map((r) => ({
        r,
        start: stamp(r.checkIn),
        end: stamp(r.checkOut),
      }));
      const attendanceMinutes =
        instants.length &&
        instants.every(
          (r) =>
            r.start !== null &&
            r.end !== null &&
            r.end >= r.start &&
            r.end - r.start <= 86400000,
        )
          ? Math.round(
              instants.reduce((sum, r) => sum + (r.end! - r.start!) / 60000, 0),
            )
          : undefined;
      const starts = instants
          .map((r) => r.start)
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b),
        ends = instants
          .map((r) => r.end)
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);
      const checkIn = starts.length ? new Date(starts[0]).toISOString() : "",
        checkOut = ends.length ? new Date(ends.at(-1)!).toISOString() : "";
      if (!raw.length) {
        {
          results.push("No Attendance");
          issues.push(
            expected === null
              ? "No attendance — expected schedule and reason require HR review."
              : "No attendance — reason requires HR review.",
          );
        }
        if ((pivotWorked || 0) > 0)
          issues.push(
            "Pivot contains worked hours but no raw clock record was found.",
          );
      }
      if (raw.some((r) => !r.checkIn)) results.push("Missing Time In");
      if (raw.some((r) => !r.checkOut)) results.push("Missing Time Out");
      const incomplete =
        instants.some(
          (r) =>
            r.start === null ||
            r.end === null ||
            r.end < r.start ||
            r.end - r.start > 86400000,
        ) ||
        raw.some((r) => r.worked === null) ||
        date === "Unknown date";
      if (/^Unmatched employee/.test(g.name))
        results.push("Unmatched Employee");
      if (worked !== null && worked < 0) {
        results.push("Invalid Attendance");
        issues.push("Reported duration is negative; verify source attendance.");
      }
      if (
        attendanceMinutes !== undefined &&
        rawWorked !== null &&
        rawWorked * 60 > attendanceMinutes + rules.discrepancyMinutes + 1e-7
      ) {
        results.push("Data Discrepancy");
        issues.push(
          "Reported worked hours exceed calculated attendance duration. Source values and punches are retained.",
        );
      }
      if (incomplete) {
        results.push("Incomplete Attendance");
        issues.push(
          "Missing or invalid clock information. Odoo worked hours are retained as reported and are not estimated.",
        );
      }
      if (raw.length > 1) {
        results.push("Multiple Entries");
        issues.push(
          "Multiple attendance records may be split shifts, double tapping or branch overlap. Review every source record; none were removed.",
        );
      }
      if (
        instants.some((x, i) =>
          instants.some(
            (y, j) =>
              i < j &&
              x.start !== null &&
              x.end !== null &&
              y.start !== null &&
              y.end !== null &&
              x.start < y.end &&
              y.start < x.end,
          ),
        )
      )
        issues.push(
          "Clock records overlap. Worked hours may be double-counted in the source.",
        );
      if (
        rawWorked !== null &&
        pivotWorked !== null &&
        Math.abs(rawWorked - pivotWorked) * 60 > rules.discrepancyMinutes + 1e-7
      ) {
        results.push("Data Discrepancy");
        issues.push(
          "Attendance and Pivot worked hours differ beyond the configured tolerance. Both values are preserved.",
        );
      }
      if (raw.length && !pivot.length)
        issues.push("No corresponding daily Pivot record was found.");
      if (expected === 0 || expected === null) {
        results.push("System Error — Expected hours missing or zero");
        issues.push(
          "The system could not determine scheduled working hours for this date. HR must verify the schedule before payroll use.",
        );
      }
      const negativeAttendance =
        raw.length > 0 &&
        !incomplete &&
        worked !== null &&
        (attendanceMinutes ?? Math.round(worked * 60)) < 480;
      if (negativeAttendance) {
        results.push("Negative Attendance");
        issues.push(
          "Attendance is below the minimum 8-hour threshold; classified as Undertime for HR validation. Schedule observations and raw punches are retained.",
        );
      }
      const excessiveThreshold = rules.excessiveWorkedHours ?? 16;
      const durationHours =
        attendanceMinutes !== undefined ? attendanceMinutes / 60 : worked;
      if (
        !incomplete &&
        expected !== null &&
        expected > 9.5 &&
        durationHours !== null &&
        (expected - durationHours) * 60 > rules.discrepancyMinutes
      ) {
        results.push("Schedule Mismatch");
        issues.push(
          `The imported schedule expects ${expected}h, beyond the standard 9-hour shift. Recorded attendance is ${durationHours.toFixed(2)}h; validate this schedule variance.`,
        );
      }
      if (durationHours !== null && durationHours >= excessiveThreshold) {
        results.push("Excessive Overtime");
        issues.push(
          `Total worked time meets the ${excessiveThreshold}-hour excessive-overtime threshold. A forgotten time-out is possible; HR must verify before treating this as actual overtime.`,
        );
      } else if (attendanceCalculation(durationHours, rules)?.overtime) {
        results.push("Overtime");
      }
      let lateMinutes: number | null = null,
        earlyMinutes: number | null = null;
      // Optional schedule times do not make otherwise normal attendance an exception.
      if (
        date !== "Unknown date" &&
        starts.length &&
        ends.length &&
        !incomplete
      ) {
        const start = rules.start ? stamp(`${date} ${rules.start}`) : null;
        let end = rules.end ? stamp(`${date} ${rules.end}`) : null;
        if (end !== null && start !== null && end <= start) end += 86400000;
        lateMinutes =
          start === null
            ? null
            : Math.max(
                0,
                Math.round((starts[0] - start) / 60000) - rules.graceMinutes,
              );
        earlyMinutes =
          end === null
            ? null
            : Math.max(0, Math.round((end - ends.at(-1)!) / 60000));
        if (lateMinutes) results.push("Late");
        if (earlyMinutes) results.push("Early Out");
      }
      if (!results.length)
        results.push(issues.length ? "Review Required" : "Normal");
      records.push({
        id: `${key}|${date}`,
        attendanceMinutes,
        employee: g.name,
        employeeId: key.startsWith("id:") ? key.slice(3) : undefined,
        sourceNames: [...g.names],
        department: [
          ...new Set(raw.map((r) => r.department).filter(Boolean)),
        ].join(", "),
        location: [...new Set(raw.map((r) => r.location).filter(Boolean))].join(
          ", ",
        ),
        date,
        checkIn,
        checkOut,
        rawWorked,
        pivotWorked,
        worked,
        expected,
        difference,
        pivotDifference: total(pivot.map((r) => r.difference)),
        balance: total(pivot.map((r) => r.balance)),
        overtime,
        extra,
        lateMinutes,
        earlyMinutes,
        results: [...new Set(results)],
        issues,
        raw,
        pivot,
        review: {
          status:
            issues.length ||
            results.some((r) => !["Normal", "Rest Day / Day Off"].includes(r))
              ? "For Review"
              : "Resolved",
          note: "",
          reviewer: "",
          reviewedAt: "",
          history: [],
        },
      });
    }
  }
  for (const record of records) {
    applyScheduleClassification(record, rules);
    refreshAttendanceAutomation(record, rules);
  }
  for (const record of records)
    if (isZeroExpectedHoursSystemIssue(record))
      record.review.classification = "System / Data Issue";
  return {
    version: ODOO_ANALYSIS_VERSION,
    rules,
    aliases,
    period: reports.period,
    sources: reports.sources,
    warnings: reports.warnings,
    records,
  };
}

/** A missing day is leave only when the source explicitly establishes leave. */
export function classifySingleWeeklyLeave(records: OdooDay[]) {
  for (const record of records)
    if (
      record.pivot.some((day) => day.schedule === "Leave") &&
      !record.raw.length &&
      !(record.worked && record.worked > 0)
    ) {
      record.schedule = "Leave";
      record.results = ["Leave"];
      record.issues = [];
      record.review.classification ||= "Leave";
      record.review.status = "Resolved";
    }
}

function applyScheduleClassification(record: OdooDay, rules: OdooRules) {
  const schedules = [
    ...new Set(
      [...record.raw, ...record.pivot].map((r) => r.schedule).filter(Boolean),
    ),
  ];
  record.schedule =
    schedules[0] ||
    (record.expected !== null && record.expected > 0
      ? "Workday"
      : rules.workDays.length &&
          odooDate(record.date) &&
          !rules.workDays.includes(new Date(record.date).getUTCDay())
        ? "Rest Day"
        : undefined);
  if (schedules.length > 1) {
    record.results.push("Invalid Schedule");
    record.issues.push(
      "Contradictory schedule classifications in the source reports.",
    );
  }
  const noWork =
    !record.raw.some((r) => r.checkIn || r.checkOut || (r.worked ?? 0) > 0) &&
    !(record.worked && record.worked > 0);
  if (
    noWork &&
    record.schedule === "Workday" &&
    record.results.includes("No Attendance")
  )
    record.results.push("Unverified Absence");
  if (
    noWork &&
    schedules.length <= 1 &&
    ["Leave", "Rest Day", "Absent"].includes(record.schedule || "")
  ) {
    record.results = [
      record.schedule === "Rest Day" ? "Rest Day / Day Off" : record.schedule!,
    ];
    record.issues = [];
    record.review.classification =
      record.schedule === "Rest Day"
        ? "Day Off"
        : record.schedule === "Absent"
          ? "Absent"
          : "Leave";
  } else if (
    !noWork &&
    ["Leave", "Rest Day", "Absent"].includes(record.schedule || "")
  ) {
    record.results.push("Schedule Mismatch");
    record.issues.push(
      "Attendance exists on a source leave, rest, or absence day; verify the schedule.",
    );
  }
  const normal =
    record.issues.length === 0 &&
    record.results.every((r) =>
      ["Normal", "Rest Day / Day Off", "Leave", "Absent"].includes(r),
    );
  if (record.results.includes("Negative Attendance"))
    record.review.classification = "Undertime";
  record.review.status = normal ? "Resolved" : "For Review";
  if (normal) record.review.reviewer = "System";
}

/** Apply the new defaults to older saved cutoffs without discarding HR history. */
export function upgradeOdooAnalysis<T extends OdooAnalysis>(analysis: T): T {
  if (analysis.version >= ODOO_ANALYSIS_VERSION) return analysis;
  for (const record of analysis.records) {
    if (!record.raw.length && record.results.includes("No Attendance")) {
      record.results = record.results.filter(
        (result) => result !== "Negative Attendance",
      );
      record.issues = record.issues.filter(
        (issue) => !issue.startsWith("Negative attendance is ambiguous"),
      );
    }
  }
  if (
    analysis.rules.excessiveWorkedHours === 14 ||
    analysis.rules.excessiveWorkedHours === undefined
  ) {
    analysis.rules.excessiveWorkedHours = 16;
    for (const record of analysis.records) {
      if (record.worked === null || record.worked < 9) continue;
      record.results = record.results.filter(
        (result) => result !== "Overtime" && result !== "Excessive Overtime",
      );
      record.results.push(
        record.worked >= 16 ? "Excessive Overtime" : "Overtime",
      );
      record.issues = record.issues.filter(
        (issue) => !issue.startsWith("Total worked time meets the "),
      );
      if (record.worked >= 16)
        record.issues.push(
          "Total worked time meets the 16-hour excessive-overtime threshold. HR verification required.",
        );
    }
  }
  // Recompute from retained source rows using the current rules. Human reviews
  // remain protected; heuristic leave classifications without HR history do not.
  const fresh = analyzeOdoo(
    {
      attendance: analysis.records.flatMap((r) => r.raw),
      pivot: analysis.records.flatMap((r) => r.pivot),
      period: analysis.period,
      sources: analysis.sources,
      warnings: analysis.warnings,
      aliases: [],
    },
    analysis.rules,
    analysis.aliases,
  );
  const byId = new Map(fresh.records.map((r) => [r.id, r]));
  for (const record of analysis.records) {
    const next = byId.get(record.id);
    if (!next || (!record.raw.length && !record.pivot.length)) continue;
    const saved = record.review;
    Object.assign(record, next);
    if (
      saved.history.length ||
      saved.note ||
      (saved.reviewer && saved.reviewer !== "System")
    )
      record.review = saved;
    refreshAttendanceAutomation(record, analysis.rules);
  }
  for (const record of analysis.records)
    if (isZeroExpectedHoursSystemIssue(record) && !record.review.classification)
      record.review.classification = "System / Data Issue";
  analysis.version = ODOO_ANALYSIS_VERSION;
  return analysis;
}

/** Recalculate the active day from retained rows; removed rows remain audit evidence. */
export function correctDuplicateAttendance(
  record: OdooDay,
  rules: OdooRules,
  retainedSourceRows: number[],
) {
  const retained = record.raw.filter((source) =>
    retainedSourceRows.includes(source.row),
  );
  const removed = record.raw.filter(
    (source) => !retainedSourceRows.includes(source.row),
  );
  const analysis = analyzeOdoo(
    {
      attendance: retained.map((source) => ({
        ...source,
        employee: record.employee,
      })),
      pivot: record.pivot.map((source) => ({
        ...source,
        employee: record.employee,
      })),
      sources: [],
      period: { start: record.date, end: record.date, title: record.date },
      warnings: [],
      aliases: [],
    },
    rules,
  );
  const recalculated = analysis.records.find(
    (day) => day.date === record.date && day.raw.length,
  );
  if (!recalculated) throw Error("Choose a dated attendance row to retain.");
  const review = record.review;
  Object.assign(record, recalculated, {
    id: record.id,
    employee: record.employee,
    employeeId: record.employeeId,
    sourceNames: record.sourceNames,
    raw: retained,
    pivot: record.pivot,
    review,
  });
  review.duplicateResolution = {
    retainedSourceRows: retained.map((source) => source.row),
    disregardedSourceRows: [
      ...new Set([
        ...(review.duplicateResolution?.disregardedSourceRows || []),
        ...removed.map((source) => source.row),
      ]),
    ],
    retainedRecords: retained,
    disregardedRecords: [
      ...(review.duplicateResolution?.disregardedRecords || []),
      ...removed,
    ].filter(
      (source, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.row === source.row &&
            candidate.checkIn === source.checkIn &&
            candidate.checkOut === source.checkOut,
        ) === index,
    ),
  };
}

export function analyzeOdoo(
  reports: OdooReports,
  rules: OdooRules,
  aliases: Record<string, string> = {},
): OdooAnalysis {
  const steps = analyzeOdooSteps(reports, rules, aliases);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
export async function analyzeOdooAsync(
  reports: OdooReports,
  rules: OdooRules,
  aliases: Record<string, string> = {},
  progress?: (processed: number, total: number) => Promise<void>,
): Promise<OdooAnalysis> {
  const steps = analyzeOdooSteps(reports, rules, aliases);
  let step = steps.next();
  while (!step.done) {
    await progress?.(step.value.processed, step.value.total);
    await new Promise((resolve) => setTimeout(resolve, 0));
    step = steps.next();
  }
  await progress?.(step.value.records.length, step.value.records.length);
  return step.value;
}
