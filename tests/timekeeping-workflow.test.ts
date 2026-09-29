import assert from "node:assert/strict";
import test from "node:test";
import type { OdooDay } from "../lib/odoo";
import {
  cutoffWorkflow,
  employeeAttendanceSummary,
  issueExplanation,
  queueGroups,
} from "../lib/timekeeping-workflow";

function record(
  id: string,
  results: string[],
  review: Partial<OdooDay["review"]> = {},
): OdooDay {
  return {
    id,
    employee: "Example Employee",
    sourceNames: ["Example Employee"],
    department: "",
    location: "",
    date: `2026-09-${id.padStart(2, "0")}`,
    checkIn: "",
    checkOut: "",
    rawWorked: null,
    pivotWorked: null,
    worked: results.includes("Excessive Overtime") ? 14.5 : null,
    expected: 8,
    difference: results.includes("Negative Attendance") ? -1 : null,
    pivotDifference: null,
    balance: null,
    overtime: null,
    extra: null,
    lateMinutes: null,
    earlyMinutes: null,
    results,
    issues: results.includes("Normal") ? [] : ["Requires HR review"],
    raw: [],
    pivot: [],
    review: {
      status: "For Review",
      note: "",
      reviewer: "",
      reviewedAt: "",
      history: [],
      ...review,
    },
  };
}

test("work queue keeps ambiguity active until HR decides, then removes it after resolution", () => {
  const negative = record("01", ["Negative Attendance"]);
  const cleared = record("02", ["Normal"], { status: "Resolved" });
  const initial = cutoffWorkflow([negative, cleared]);
  assert.equal(initial.actionRequired.length, 1);
  assert.equal(initial.remaining, 1);
  assert.equal(
    queueGroups([negative]).find((group) => group.id === "negative-attendance")
      ?.records.length,
    1,
  );

  negative.review = {
    ...negative.review,
    status: "Resolved",
    classification: "Early Out",
    note: "Supervisor confirmed early departure.",
    history: [
      {
        previous: "For Review",
        next: "Resolved",
        reviewer: "hr@example.invalid",
        timestamp: "2026-09-30T09:00:00.000Z",
        note: "Supervisor confirmed early departure.",
      },
    ],
  };
  const resolved = cutoffWorkflow([negative, cleared]);
  assert.equal(resolved.actionRequired.length, 0);
  assert.equal(resolved.remaining, 0);
  assert.equal(resolved.progress, 100);
});

test("employee cutoff summary represents no-attendance dates rather than dropping them", () => {
  const noAttendance = record("03", ["No Attendance"]);
  const normal = record("04", ["Normal"], { status: "Resolved" });
  const summary = employeeAttendanceSummary([noAttendance, normal]);
  assert.equal(summary.cutoffDays, 2);
  assert.equal(summary.recordedDays, 0);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.clarification, 1);
  assert.match(issueExplanation(noAttendance), /not automatically an absence/i);
});

test("excessive overtime remains an HR verification issue, not an automatic approval", () => {
  const excessive = record("05", ["Excessive Overtime"]);
  assert.match(issueExplanation(excessive), /14\+ hours/i);
  assert.equal(cutoffWorkflow([excessive]).actionRequired.length, 1);
});
