export type AttendanceRules = {
  start: string;
  end: string;
  grace: number;
  overtimeGrace: number;
  breakMinutes: number;
  timezone: "Asia/Manila" | "Asia/Singapore" | "UTC";
  dateOrder: "DMY" | "MDY" | "ISO";
};
export const defaultAttendanceRules: AttendanceRules = {
  start: "09:00",
  end: "18:00",
  grace: 5,
  overtimeGrace: 0,
  breakMinutes: 60,
  timezone: "Asia/Manila",
  dateOrder: "DMY",
};
export type AttendanceMapping = {
  employee: number;
  checkIn: number;
  checkOut: number;
};
export type AttendanceResult = {
  employee: string;
  date: string;
  checkIn: string;
  checkOut: string;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  earlyOutMinutes: number;
  issues: string[];
  sourceRows: number[];
};
export function detectAttendanceColumns(headers: string[]): AttendanceMapping {
  const find = (pattern: RegExp) =>
    headers.findIndex((h) => pattern.test(h.trim()));
  return {
    employee: find(/^(employee(?:\s*\/.*| name)?|name|staff|employee_id)$/i),
    checkIn: find(
      /^(check[ _-]?in|clock[ _-]?in|time[ _-]?in|in time|start)$/i,
    ),
    checkOut: find(
      /^(check[ _-]?out|clock[ _-]?out|time[ _-]?out|out time|end)$/i,
    ),
  };
}
export function attendanceTimestamp(
  value: string,
  rules: AttendanceRules,
): number | null {
  if (!value.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const normalized = value.trim().replace("T", " ");
  const match = normalized.match(
    /^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  const [first, second, third] = match.slice(1, 4).map(Number);
  const yearFirst = match[1].length === 4;
  const year = yearFirst ? first : third,
    month = yearFirst ? second : rules.dateOrder === "MDY" ? first : second,
    day = yearFirst ? third : rules.dateOrder === "MDY" ? second : first;
  if (rules.dateOrder === "ISO" && !yearFirst) return null;
  let hour = Number(match[4]);
  const minute = Number(match[5]),
    seconds = Number(match[6] || 0);
  if (match[7]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[7].toUpperCase() === "PM" ? 12 : 0);
  }
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    seconds > 59
  )
    return null;
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, seconds));
  if (wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day)
    return null;
  return wall.getTime() - (rules.timezone === "UTC" ? 0 : 8 * 3600000);
}
export function analyzeAttendance(
  rows: string[][],
  mapping: AttendanceMapping,
  rules: AttendanceRules,
  sourceRows?: number[],
) {
  const offset = rules.timezone === "UTC" ? 0 : 8 * 3600000;
  const minutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  const shiftStart = minutes(rules.start),
    shiftEnd = minutes(rules.end),
    overnight = shiftEnd <= shiftStart;
  const seen = new Set<string>();
  let duplicates = 0;
  const groups = new Map<
    string,
    {
      employee: string;
      date: string;
      times: { start: number | null; end: number | null; row: number }[];
    }
  >();
  rows.forEach((row, index) => {
    const employee = row[mapping.employee]?.trim() || "Missing employee";
    const checkIn = row[mapping.checkIn] || "",
      checkOut = row[mapping.checkOut] || "";
    const key = JSON.stringify([employee.toLowerCase(), checkIn, checkOut]);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    const start = attendanceTimestamp(checkIn, rules),
      end = attendanceTimestamp(checkOut, rules);
    const reference = start ?? end;
    let date =
      reference === null
        ? "Unknown date"
        : new Date(reference + offset).toISOString().slice(0, 10);
    if (reference !== null && overnight) {
      const local = new Date(reference + offset);
      if (local.getUTCHours() * 60 + local.getUTCMinutes() < shiftEnd)
        date = new Date(reference + offset - 86400000)
          .toISOString()
          .slice(0, 10);
    }
    const groupKey = `${employee.toLowerCase()}|${date}${date === "Unknown date" || employee === "Missing employee" ? `|${index}` : ""}`;
    const group = groups.get(groupKey) || { employee, date, times: [] };
    group.times.push({ start, end, row: sourceRows?.[index] ?? index + 2 });
    groups.set(groupKey, group);
  });
  const results: AttendanceResult[] = [...groups.values()].map(
    ({ employee, date, times }) => {
      const issues: string[] = [];
      if (employee === "Missing employee") issues.push("Missing employee");
      if (times.some((t) => t.start === null))
        issues.push("Missing or invalid check-in");
      if (times.some((t) => t.end === null))
        issues.push("Missing or invalid check-out");
      if (
        times.some((t) => t.start !== null && t.end !== null && t.end < t.start)
      )
        issues.push("Check-out precedes check-in");
      if (
        times.some(
          (t) =>
            t.start !== null &&
            t.end !== null &&
            t.end - t.start > 24 * 3600000,
        )
      )
        issues.push("Entry exceeds 24 hours; verify dates");
      const sorted = times
        .filter((t) => t.start !== null && t.end !== null)
        .sort((a, b) => a.start! - b.start!);
      if (sorted.some((t, i) => i > 0 && t.start! < sorted[i - 1].end!))
        issues.push("Overlapping attendance entries");
      const starts = times.flatMap((t) => (t.start === null ? [] : [t.start]));
      const ends = times.flatMap((t) => (t.end === null ? [] : [t.end]));
      const first = starts.length ? Math.min(...starts) : null,
        last = ends.length ? Math.max(...ends) : null;
      const day =
        date === "Unknown date" ? 0 : Date.parse(`${date}T00:00:00Z`) - offset;
      const plannedStart = day + shiftStart * 60000,
        plannedEnd = day + (shiftEnd + (overnight ? 1440 : 0)) * 60000;
      const format = (value: number | null) =>
        value === null
          ? "Missing"
          : new Date(value + offset)
              .toISOString()
              .replace("T", " ")
              .slice(0, 16);
      const duration = sorted.reduce(
        (total, t) => total + Math.max(0, (t.end! - t.start!) / 60000),
        0,
      );
      const incomplete = issues.length > 0;
      return {
        employee,
        date,
        checkIn: format(first),
        checkOut: format(last),
        workedMinutes: incomplete
          ? 0
          : Math.max(
              0,
              Math.round(
                duration - (times.length === 1 ? rules.breakMinutes : 0),
              ),
            ),
        lateMinutes:
          incomplete || first === null
            ? 0
            : Math.max(
                0,
                Math.floor((first - plannedStart) / 60000) - rules.grace,
              ),
        earlyOutMinutes:
          incomplete || last === null
            ? 0
            : Math.max(0, Math.floor((plannedEnd - last) / 60000)),
        overtimeMinutes:
          incomplete || last === null
            ? 0
            : Math.max(
                0,
                Math.floor((last - plannedEnd) / 60000) - rules.overtimeGrace,
              ),
        issues,
        sourceRows: times.map((t) => t.row),
      };
    },
  );
  return {
    results,
    duplicates,
    summary: {
      days: results.length,
      needsReview: results.filter((r) => r.issues.length).length,
      lateMinutes: results.reduce((sum, r) => sum + r.lateMinutes, 0),
      overtimeMinutes: results.reduce((sum, r) => sum + r.overtimeMinutes, 0),
      earlyOutMinutes: results.reduce((sum, r) => sum + r.earlyOutMinutes, 0),
    },
  };
}
