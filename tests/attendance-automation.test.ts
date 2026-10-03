import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeOdoo,
  defaultOdooRules,
  upgradeOdooAnalysis,
  type OdooReports,
} from "../lib/odoo";
import {
  attendanceCalculation,
  matchesAttendance,
} from "../lib/attendance-automation";
import {
  cutoffWorkflow,
  employeeAttendanceSummary,
} from "../lib/timekeeping-workflow";

function report(minutes = 540): OdooReports {
  return {
    attendance: [
      {
        row: 2,
        employee: "Juan Dela Cruz",
        employeeId: "employee-1",
        checkIn: "2026-09-07 09:00:00",
        checkOut: new Date(Date.parse("2026-09-07T09:00:00Z") + minutes * 60000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19),
        worked: minutes / 60,
        overtime: 0,
        extra: 0,
        location: "Naga City",
      },
    ],
    pivot: [
      {
        row: 2,
        employee: "Juan Dela Cruz",
        date: "2026-09-07",
        worked: minutes / 60,
        expected: 9,
        difference: minutes / 60 - 9,
        balance: 0,
      },
    ],
    period: { start: "2026-09-07", end: "2026-09-07", title: "Cutoff" },
    sources: [],
    warnings: [],
    aliases: [],
  };
}
test("all duration boundaries classify automatically and preserve precise source values", () => {
  for (const minutes of [
    480, 481, 495, 510, 539, 540, 541, 553, 555, 569, 570, 571, 583, 585, 600,
    601, 613, 630, 631, 659, 660,
  ]) {
    const source = report(minutes),
      before = structuredClone(source);
    const r = analyzeOdoo(source, defaultOdooRules).records[0];
    assert.equal(
      r.results.includes("Overtime"),
      minutes > 570,
      `${minutes} minutes`,
    );
    assert.equal(r.review.status, minutes > 570 ? "For Review" : "Resolved");
    assert.equal(r.severity, minutes > 570 ? "High" : "Low");
    assert.equal(r.calculation?.totalMinutes, minutes);
    assert.equal(r.calculation?.additionalMinutes, Math.max(0, minutes - 540));
    assert.equal(
      r.calculation?.remainderMinutes,
      Math.max(0, minutes - 540) % 60,
    );
    assert.equal(
      r.calculation?.creditedMinutes,
      minutes > 570 ? Math.floor((minutes - 540 + 29) / 60) * 60 : 0,
    );
    assert.deepEqual(source, before, "raw inputs are never mutated");
    if (minutes < 540)
      assert.match(r.calculation!.notes.join(" "), /minimum 8-hour threshold/);
  }
  assert.equal(attendanceCalculation(null, defaultOdooRules), undefined);
  assert.equal(attendanceCalculation(-1, defaultOdooRules), undefined);
  const scheduled = report(480);
  scheduled.pivot[0].expected = 12;
  const variance = analyzeOdoo(scheduled, defaultOdooRules).records[0];
  assert.ok(variance.results.includes("Schedule Mismatch"));
  assert.ok(!variance.results.includes("Negative Attendance"));
  assert.equal(variance.severity, "High");
  assert.equal(
    attendanceCalculation(10 + 13 / 60, defaultOdooRules)?.creditedMinutes,
    60,
  );
});
test("short shifts, missing punches, invalid duration and duplicates stay in the queue, sorted by severity", () => {
  const normal = analyzeOdoo(report(480), defaultOdooRules).records[0];
  const short = analyzeOdoo(report(479), defaultOdooRules).records[0];
  assert.equal(
    analyzeOdoo(report(420), defaultOdooRules).records[0].review.status,
    "For Review",
  );
  assert.equal(short.review.classification, "Undertime");
  assert.equal(short.severity, "Medium");
  const missing = report();
  missing.attendance[0].checkOut = "";
  const critical = analyzeOdoo(missing, defaultOdooRules).records[0];
  assert.equal(critical.severity, "Critical");
  const contradictory = report(30);
  contradictory.attendance[0].worked = 9;
  contradictory.pivot[0].worked = 9;
  assert.equal(
    analyzeOdoo(contradictory, defaultOdooRules).records[0].severity,
    "Critical",
  );
  const duplicated = report();
  duplicated.attendance.push({ ...duplicated.attendance[0], row: 3 });
  assert.equal(
    analyzeOdoo(duplicated, defaultOdooRules).records[0].severity,
    "Critical",
  );
  const queue = cutoffWorkflow([short, normal, critical]);
  assert.equal(queue.automaticallyCleared.length, 1);
  assert.equal(queue.actionRequired[0].severity, "Critical");
});
test("leave and rest need source evidence; scheduled missing attendance is an unverified absence", () => {
  const missing = report(0);
  missing.attendance = [];
  let row = analyzeOdoo(missing, defaultOdooRules).records[0];
  assert.ok(row.results.includes("Unverified Absence"));
  assert.equal(row.review.classification, undefined);
  for (const schedule of ["Leave", "Rest Day", "Absent"] as const) {
    const source = structuredClone(missing);
    source.pivot[0].schedule = schedule;
    row = analyzeOdoo(source, defaultOdooRules).records[0];
    assert.equal(row.review.status, "Resolved");
    assert.equal(row.severity, "Low");
    assert.equal(row.schedule, schedule);
    assert.equal(
      employeeAttendanceSummary([row]).leaveDays,
      schedule === "Leave" ? 1 : 0,
    );
    assert.equal(
      employeeAttendanceSummary([row]).absenceDays,
      schedule === "Absent" ? 1 : 0,
    );
  }
  const invalid = report();
  invalid.pivot[0].schedule = "Leave";
  assert.equal(
    analyzeOdoo(invalid, defaultOdooRules).records[0].severity,
    "High",
  );
});
test("overnight attendance and source worked time excluding lunch remain visible", () => {
  const source = report();
  source.attendance[0].checkIn = "2026-09-07 22:00:00";
  source.attendance[0].checkOut = "2026-09-08 07:00:00";
  source.attendance[0].worked = 8;
  source.pivot[0].worked = 8;
  const r = analyzeOdoo(source, {
    ...defaultOdooRules,
    start: "22:00",
    end: "07:00",
  }).records[0];
  assert.equal(r.review.status, "Resolved");
  assert.equal(r.worked, 8);
  assert.equal(r.attendanceMinutes, 540);
  assert.match(r.calculation!.notes.join(" "), /Source worked time: 8h00/);
});
test("upgrading old cutoffs clears normal records and protects human overrides", () => {
  const old = analyzeOdoo(report(480), defaultOdooRules);
  old.version = 6;
  old.records[0].results = ["Negative Attendance"];
  old.records[0].review.status = "For Review";
  const next = upgradeOdooAnalysis(old);
  assert.deepEqual(next.records[0].results, ["Normal"]);
  assert.equal(next.records[0].review.status, "Resolved");
  const manual = analyzeOdoo(report(480), defaultOdooRules);
  manual.version = 6;
  manual.records[0].review = {
    status: "Excused",
    classification: "Early Out",
    note: "HR confirmed",
    reviewer: "hr@example.invalid",
    reviewedAt: "2026-09-08T00:00:00Z",
    history: [
      {
        previous: "For Review",
        next: "Excused",
        note: "HR confirmed",
        reviewer: "hr@example.invalid",
        timestamp: "2026-09-08T00:00:00Z",
      },
    ],
  };
  const saved = structuredClone(manual.records[0].review);
  upgradeOdooAnalysis(manual);
  assert.deepEqual(manual.records[0].review, saved);
  assert.ok(
    matchesAttendance(manual.records[0], {
      severity: "Low",
      location: "Naga City",
      query: "juan",
    }),
  );
  assert.equal(
    matchesAttendance(manual.records[0], { location: "Santa Rosa" }),
    false,
  );
});
