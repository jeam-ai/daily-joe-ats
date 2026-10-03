import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeOdoo,
  parseOdooReports,
  defaultOdooRules,
  type OdooMatrix,
  type OdooReports,
  upgradeOdooAnalysis,
} from "../lib/odoo";
const raw: OdooMatrix = [
  [
    "Employee",
    "Check In",
    "Check Out",
    "Worked Hours",
    "Over Time",
    "Extra Hours",
  ],
  ["DEMO Alex", "2026-09-01 08:30:00", "2026-09-01 17:00:00", 8.5, 0.5, 0],
  ["DEMO Alex (2)", "2026-09-01 09:00:00", "2026-09-01 17:00:00", 8, 0, 0],
  ["DEMO Alex", "2026-09-03 09:00:00", "", 0, 0, 0],
];
const pivot: OdooMatrix = [
  [null, "Total"],
  [null, "September 2026"],
  [null, "Worked Hours", "Expected Hours", "Difference", "Balance"],
  ["Total", 16.5, 16, 0.5, 0.5],
  ["    DEMO Alex", 8.5, 8, 0.5, 0.5],
  ["          01 Sep 2026", 8.5, 8, 0.5, 0.5],
  ["          02 Sep 2026", 0, 0, 0, 0],
  ["          03 Sep 2026", 0, 8, -8, -8],
  ["    DEMO Alex (2)", 8, 8, 0, 0],
  ["          01 Sep 2026", 8, 8, 0, 0],
];
test("Odoo hierarchy excludes totals, preserves source precision and requires both report structures", () => {
  const r = parseOdooReports(raw, pivot, []);
  assert.equal(r.attendance.length, 3);
  assert.equal(r.pivot.length, 4);
  assert.deepEqual(r.period, {
    start: "2026-09-01",
    end: "2026-09-03",
    title: "September 2026",
  });
  assert.throws(() => parseOdooReports(raw, raw, []), /Pivot/);
  assert.throws(() => parseOdooReports(pivot, pivot, []), /Attendance/);
});
test("Odoo defaults do not invent schedules, merge identities or discard source rows", () => {
  const r = parseOdooReports(raw, pivot, []),
    a = analyzeOdoo(r, defaultOdooRules);
  assert.equal(new Set(a.records.map((r) => r.employee)).size, 2);
  assert.equal(a.records.flatMap((r) => r.raw).length, 3);
  assert.ok(a.records.every((r) => r.lateMinutes === null));
  const rest = a.records.find(
    (r) => r.employee === "DEMO Alex" && r.date === "2026-09-02",
  )!;
  assert.ok(
    rest.results.includes("System Error — Expected hours missing or zero"),
  );
  const missing = a.records.find(
    (r) => r.employee === "DEMO Alex" && r.date === "2026-09-03",
  )!;
  assert.ok(missing.results.includes("Missing Time Out"));
  assert.ok(!missing.results.includes("Undertime"));
  assert.equal(missing.review.status, "For Review");
});
test("confirmed aliases retain multiple clock records and ambiguous Pivot expected hours", () => {
  const a = analyzeOdoo(parseOdooReports(raw, pivot, []), defaultOdooRules, {
    "DEMO Alex (2)": "DEMO Alex",
  });
  assert.equal(new Set(a.records.map((r) => r.employee)).size, 1);
  const day = a.records[0];
  assert.equal(day.raw.length, 2);
  assert.equal(day.rawWorked, 16.5);
  assert.equal(day.expected, null);
  assert.ok(day.results.includes("Multiple Entries"));
  assert.ok(day.issues.some((i) => i.includes("overlap")));
  assert.deepEqual(day.sourceNames, ["DEMO Alex", "DEMO Alex (2)"]);
});
test("explicit schedule supports late/early-out and tolerance preserves discrepant values", () => {
  const p = structuredClone(pivot);
  p[5][1] = 7;
  const a = analyzeOdoo(parseOdooReports(raw, p, []), {
    ...defaultOdooRules,
    start: "08:00",
    end: "18:00",
    graceMinutes: 5,
  });
  const day = a.records[0];
  assert.equal(day.lateMinutes, 25);
  assert.equal(day.earlyMinutes, 60);
  assert.ok(day.results.includes("Data Discrepancy"));
  assert.equal(day.rawWorked, 8.5);
  assert.equal(day.pivotWorked, 7);
});
test("8+ hours is normal duration and only explicit schedule rules flag late or early-out", () => {
  const p = structuredClone(pivot);
  // Raw time is late and early, but the negative result alone cannot establish
  // which explanation HR should record.
  p[5][2] = 9;
  const analysis = analyzeOdoo(parseOdooReports(raw, p, []), {
    ...defaultOdooRules,
    start: "08:00",
    end: "18:00",
  });
  const day = analysis.records.find(
    (r) => r.employee === "DEMO Alex" && r.date === "2026-09-01",
  )!;
  assert.ok(!day.results.includes("Negative Attendance"));
  assert.ok(day.results.includes("Late"));
  assert.ok(day.results.includes("Early Out"));
  assert.ok(!day.results.includes("Undertime"));
  assert.equal(day.review.classification, undefined);
  const absent = analysis.records.find(
    (r) => r.employee === "DEMO Alex" && r.date === "2026-09-02",
  )!;
  assert.ok(absent.results.includes("No Attendance"));
  assert.equal(absent.review.classification, undefined);
});

function attendanceWeek(
  missing: number[],
  workedHours = 8,
  start = "2026-09-07",
): OdooReports {
  const dates = Array.from({ length: 7 }, (_, index) =>
    new Date(Date.parse(start) + index * 86400000).toISOString().slice(0, 10),
  );
  return {
    attendance: dates
      .filter((_, index) => !missing.includes(index))
      .map((date, index) => ({
        row: index + 2,
        employee: "QA Weekly",
        employeeId: "qa-weekly",
        checkIn: `${date} 08:00:00`,
        checkOut: new Date(
          Date.parse(`${date}T08:00:00Z`) +
            Math.round(workedHours * 60) * 60000,
        )
          .toISOString()
          .replace("T", " ")
          .slice(0, 19),
        worked: workedHours,
        overtime: 0,
        extra: 0,
      })),
    pivot: dates.map((date, index) => ({
      row: index + 2,
      employee: "QA Weekly",
      date,
      worked: missing.includes(index) ? 0 : workedHours,
      expected: 8,
      difference: missing.includes(index) ? -8 : workedHours - 8,
      balance: 0,
    })),
    sources: [],
    aliases: [],
    warnings: [],
    period: { start: dates[0], end: dates[6], title: "QA Week" },
  };
}

test("missing days need evidence for leave and remain unverified without a source schedule", () => {
  const single = analyzeOdoo(attendanceWeek([2]), defaultOdooRules).records[2];
  assert.deepEqual(single.results, ["No Attendance", "Unverified Absence"]);
  assert.equal(single.review.classification, undefined);
  assert.equal(single.review.status, "For Review");
  for (const missing of [
    [1, 4],
    [2, 3],
  ]) {
    const records = analyzeOdoo(
      attendanceWeek(missing),
      defaultOdooRules,
    ).records;
    for (const index of missing) {
      assert.ok(records[index].results.includes("No Attendance"));
      assert.equal(records[index].review.classification, undefined);
    }
  }
  const crossWeek = analyzeOdoo(
    attendanceWeek([2, 3], 8, "2026-09-11"),
    defaultOdooRules,
  ).records;
  assert.ok(crossWeek[2].results.includes("No Attendance"));
  assert.ok(crossWeek[3].results.includes("No Attendance"));
  const inconsistent = attendanceWeek([2]);
  inconsistent.pivot[2].worked = 8;
  assert.ok(
    analyzeOdoo(inconsistent, defaultOdooRules).records[2].results.includes(
      "No Attendance",
    ),
  );
});

test("overtime starts at 9h31 and becomes excessive at 16", () => {
  for (const hours of [8.99, 9, 9.5, 9 + 31 / 60, 14, 15.99, 16]) {
    const day = analyzeOdoo(attendanceWeek([], hours), defaultOdooRules)
      .records[0];
    assert.equal(
      day.results.includes("Overtime"),
      Math.round(hours * 60) > 570 && hours < 16,
    );
    assert.equal(day.results.includes("Excessive Overtime"), hours >= 16);
  }
  const old = analyzeOdoo(attendanceWeek([], 14), {
    ...defaultOdooRules,
    excessiveWorkedHours: 14,
  });
  old.version = 5;
  old.records[0].review.note = "Existing review";
  const upgraded = upgradeOdooAnalysis(old);
  assert.equal(upgraded.rules.excessiveWorkedHours, 16);
  assert.ok(upgraded.records[0].results.includes("Overtime"));
  assert.ok(!upgraded.records[0].results.includes("Excessive Overtime"));
  assert.equal(upgraded.records[0].review.note, "Existing review");
});
test("Odoo floating-point rest-day residue and independently configured start times stay traceable", () => {
  const p = structuredClone(pivot);
  p[6][2] = 1e-15;
  const analysis = analyzeOdoo(parseOdooReports(raw, p, []), {
    ...defaultOdooRules,
    start: "08:00",
  });
  const rest = analysis.records.find(
    (r) => r.employee === "DEMO Alex" && r.date === "2026-09-02",
  )!;
  assert.equal(rest.expected, 0);
  assert.equal(rest.pivot[0].expected, 1e-15);
  assert.ok(
    rest.results.includes("System Error — Expected hours missing or zero"),
  );
  assert.equal(analysis.records[0].lateMinutes, 30);
  assert.equal(analysis.records[0].earlyMinutes, null);
});
