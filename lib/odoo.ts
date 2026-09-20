import { attendanceTimestamp, defaultAttendanceRules } from "./timekeeping";
export const ODOO_ANALYSIS_VERSION = 3;

export type OdooCell = string | number | null;
export type OdooMatrix = OdooCell[][];
export type OdooSource = {
  filename: string;
  sheet: string;
  hash: string;
  rows: number;
};
export type RawAttendance = {
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
  timezone: "Asia/Manila" | "Asia/Singapore" | "UTC";
  start: string;
  end: string;
  graceMinutes: number;
  overtimeMinutes: number;
  discrepancyMinutes: number;
  expectedHours: number | null;
  workDays: number[];
};
export const defaultOdooRules: OdooRules = {
  timezone: "Asia/Manila",
  start: "",
  end: "",
  graceMinutes: 0,
  overtimeMinutes: 0,
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
export type OdooReview = {
  status: ReviewStatus;
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
    const employee = clean(row[cols.employee]);
    if (!employee) {
      warnings.push(
        `Attendance row ${h + i + 2} has no employee name and needs correction.`,
      );
      return;
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
      .map((r) => odooDate(r.checkIn) || odooDate(r.checkOut))
      .filter((d): d is string => !!d),
  ].sort();
  const start = workDates[0],
    end = workDates.at(-1)!;
  if (Date.parse(end) - Date.parse(start) > 93 * 86400000)
    throw Error("Choose reports covering no more than 93 days per analysis.");
  const rawDates = attendance
      .map((r) => odooDate(r.checkIn) || odooDate(r.checkOut))
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
      (r) => !odooDate(r.checkIn) && !odooDate(r.checkOut),
    );
    const days = undated.length ? [...dates, "Unknown date"] : dates;
    for (const date of days) {
      if (records.length % 200 === 0)
        yield { processed: records.length, total: groups.size * days.length };
      const raw = g.raw.filter(
          (r) =>
            (odooDate(r.checkIn) || odooDate(r.checkOut) || "Unknown date") ===
            date,
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
      const overtime = total(raw.map((r) => r.overtime)),
        extra = total(raw.map((r) => r.extra));
      const difference =
        worked !== null && expected !== null ? worked - expected : null;
      const instants = raw.map((r) => ({
        r,
        start: stamp(r.checkIn),
        end: stamp(r.checkOut),
      }));
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
        if (expected === 0) results.push("Rest Day / Day Off");
        else {
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
      if (expected === 0 && raw.length) results.push("Rest Day / Day Off");
      if (!incomplete && difference !== null && difference < -1e-7)
        results.push("Undertime");
      if (
        !incomplete &&
        ((difference !== null &&
          difference * 60 > rules.overtimeMinutes + 1e-7) ||
          (overtime !== null && overtime * 60 > rules.overtimeMinutes + 1e-7) ||
          (extra !== null && extra * 60 > rules.overtimeMinutes + 1e-7))
      )
        results.push("Overtime");
      let lateMinutes: number | null = null,
        earlyMinutes: number | null = null;
      if (!rules.start || !rules.end)
        issues.push(
          "Schedule information unavailable — late and early-out results require HR schedule configuration.",
        );
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
