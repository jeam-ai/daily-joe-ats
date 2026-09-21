import test from "node:test";
import assert from "node:assert/strict";
import { formalName, nameParts } from "../lib/names";
import {
  intakeCapacity,
  balanceIntakeWindow,
  eligibleIntake,
  INTAKE_QUEUE_LIMIT,
} from "../lib/data-policy";
import { extractionReasons } from "../lib/applicant-information";
import { analyzeOdoo, defaultOdooRules, type OdooReports } from "../lib/odoo";
import type { Application } from "../types";
import {
  databaseColumns,
  positionSheetName,
  positionViewFormula,
} from "../lib/sheets-schema";

test("custom position views retain distinct names and escape spreadsheet formula literals", () => {
  assert.equal(positionSheetName("Barista"), "Barista Applications");
  assert.notEqual(
    positionSheetName("Cashier/Barista"),
    positionSheetName("Cashier Barista"),
  );
  assert.notEqual(
    positionSheetName("X".repeat(75) + "A"),
    positionSheetName("X".repeat(75) + "B"),
  );
  assert.ok(positionSheetName("X".repeat(100)).length <= 100);
  assert.ok(positionViewFormula('Role "A"').includes('Role ""A""'));
});
test("Sheets storage accepts the resume checksum field while rejecting unknown record fields", () => {
  assert.ok(databaseColumns.resumes.includes("sha256"));
  assert.ok(!databaseColumns.resumes.includes("unexpected_field"));
});
test("100 active / 500 retained boundaries promote the next newest eligible record without deleting history", () => {
  const applications = Array.from(
    { length: INTAKE_QUEUE_LIMIT },
    (_, i) =>
      ({
        id: String(i),
        applicant: {},
        isDemo: false,
        appliedAt: new Date(2026, 0, 1, 0, i).toISOString(),
        stage: "Screening",
        status: "New",
      }) as Application,
  );
  assert.equal(intakeCapacity(applications).full, true);
  balanceIntakeWindow(applications);
  assert.equal(
    applications.filter((a) => a.queueState === "Active").length,
    100,
  );
  assert.equal(applications[399].queueState, "Queued");
  applications[499].status = "Rejected";
  balanceIntakeWindow(applications);
  assert.equal(applications[399].queueState, "Active");
  assert.equal(intakeCapacity(applications).available, 1);
  assert.equal(applications.length, INTAKE_QUEUE_LIMIT);
});
test("professional name formatting preserves initials, accents and compound surnames without guessing ambiguous order", () => {
  assert.equal(formalName("JESSA D. BABILONIA"), "Jessa D. Babilonia");
  assert.equal(formalName("BABILONIA, JESSA D."), "Jessa D. Babilonia");
  assert.equal(formalName("BABILONIA JESSA D.", true), "Jessa D. Babilonia");
  assert.equal(formalName("Jeam A. De Vera"), "Jeam A. De Vera");
  assert.equal(formalName("MARÍA O’NEILL III"), "María O’Neill III");
  assert.deepEqual(nameParts("Jeam A. De Vera"), {
    firstName: "Jeam",
    middleName: "A.",
    lastName: "De Vera",
  });
  assert.deepEqual(nameParts("Juan D. Dela Cruz Jr."), {
    firstName: "Juan",
    middleName: "D.",
    lastName: "Dela Cruz Jr.",
  });
});
test("80 percent OCR, image processing and missing phone trigger automatic extraction while demo is excluded", () => {
  const a = {
    lastActivity: "2026-09-01T00:00:00.000Z",
    id: "fixture",
    appliedAt: "2026-09-01T00:00:00.000Z",
    stage: "Screening",
    status: "New",
    assignedTo: "",
    notes: [],
    interviews: [],
    requirements: [],
    timeline: [],
    onboardingStatus: "Pending Orientation",
    screening: { criteria: [], completedAt: "", outcome: "Requires Review" },
    applicant: {
      id: "fixture-person",
      experience: 0,
      name: "Example Person",
      email: "person@example.invalid",
      phone: "123",
      location: "Pili",
    },
    position: "Barista",
    location: "Naga City",
    extraction: { method: "text", confidence: 80, warnings: [] },
  } as Application;
  assert.ok(extractionReasons(a).some((r) => r.includes("extraction")));
  a.extraction!.confidence = 81;
  assert.deepEqual(extractionReasons(a), []);
  a.applicant.phone = "";
  assert.ok(extractionReasons(a).some((r) => r.includes("Phone")));
  a.isDemo = true;
  assert.deepEqual(extractionReasons(a), []);
});
test("Odoo zero expected hours are errors, missing checkout is retained, and only total worked above 14 triggers excessive review", () => {
  const report: OdooReports = {
    attendance: [],
    pivot: [],
    sources: [],
    period: { start: "2026-09-01", end: "2026-09-01", title: "Test" },
    warnings: [],
    aliases: [],
  };
  for (const hours of [12, 14, 15, 16]) {
    report.attendance.push({
      row: hours,
      employee: String(hours),
      checkIn: "2026-09-01 06:00:00",
      checkOut: `2026-09-01 ${6 + hours}:00:00`,
      worked: hours,
      overtime: hours - 8,
      extra: 0,
    });
    report.pivot.push({
      row: hours,
      employee: String(hours),
      date: "2026-09-01",
      worked: hours,
      expected: 8,
      difference: hours - 8,
      balance: 0,
    });
  }
  report.attendance.push({
    row: 1,
    employee: "Missing",
    checkIn: "2026-09-01 09:00:00",
    checkOut: "",
    worked: 0,
    overtime: 0,
    extra: 0,
  });
  report.pivot.push({
    row: 1,
    employee: "Missing",
    date: "2026-09-01",
    worked: 0,
    expected: 0,
    difference: 0,
    balance: 0,
  });
  const result = analyzeOdoo(report, defaultOdooRules);
  for (const r of result.records) {
    if (r.employee === "Missing") {
      assert.ok(r.results.includes("Missing Time Out"));
      assert.ok(!r.results.includes("No Attendance"));
      assert.ok(r.results.some((s) => s.startsWith("System Error")));
    } else {
      assert.equal(
        r.results.includes("Excessive Overtime / System Review"),
        Number(r.employee) > 14,
      );
      assert.ok(r.results.includes("Overtime"));
    }
  }
  assert.ok(
    result.records.every((r) => !r.results.includes("Rest Day / Day Off")),
  );
});
