import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeOdoo,
  parseOdooReports,
  defaultOdooRules,
  type OdooMatrix,
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
