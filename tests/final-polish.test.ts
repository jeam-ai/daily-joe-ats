import test from "node:test";
import assert from "node:assert/strict";
import { greetingName } from "../lib/identity";
import { screenResumeAgainstCriteria, buildInsight } from "../lib/screening";
import {
  analyzeAttendance,
  attendanceTimestamp,
  defaultAttendanceRules,
  detectAttendanceColumns,
} from "../lib/timekeeping";
import { productionState } from "../lib/data-policy";
import { trackerRows } from "../lib/tracker";
import { createSeed } from "../lib/mock/seed";
import { formatDate, formatTime, monthKey, scheduledIso } from "../lib/dates";
test("workspace dates and interview times respect format and timezone across midnight", () => {
  const instant = "2026-09-30T17:30:00Z";
  assert.equal(
    formatDate(instant, { dateFormat: "en-PH", timezone: "Asia/Manila" }),
    "1 October 2026",
  );
  assert.equal(
    formatDate(instant, { dateFormat: "en-US", timezone: "UTC" }),
    "September 30, 2026",
  );
  assert.equal(monthKey(instant, "Asia/Manila"), "2026-10");
  assert.equal(monthKey(instant, "UTC"), "2026-09");
  assert.equal(formatTime(instant, { timezone: "Asia/Manila" }), "01:30 am");
  assert.equal(
    scheduledIso("2026-10-01T01:30", "Asia/Manila"),
    instant.replace("Z", ".000Z"),
  );
  assert.equal(formatDate("invalid"), "Not set");
});
test("product identity is never shortened into a person's first name", () => {
  for (const name of [
    undefined,
    "Daily",
    "Daily Joe",
    "Daily Joe Careers",
    "Daily Joe HR",
    "careers@daily-joe.com",
  ])
    assert.equal(greetingName(name), "Daily Joe Careers");
  assert.equal(greetingName("Jeam A. De Vera"), "Jeam");
});
test("missing, unreliable, and negated qualification evidence remains unclear", () => {
  const rules = [
    {
      id: "experience",
      label: "Barista experience",
      kind: "Minimum" as const,
      absenceFails: false,
    },
  ];
  assert.equal(
    screenResumeAgainstCriteria("No Barista experience", rules)[0].result,
    "Unclear",
  );
  assert.equal(
    screenResumeAgainstCriteria("Other employment history", rules)[0].result,
    "Unclear",
  );
  assert.equal(
    screenResumeAgainstCriteria("Barista experience", rules, false)[0].result,
    "Unclear",
  );
  assert.equal(
    screenResumeAgainstCriteria("Other employment history", [
      { ...rules[0], absenceFails: true },
    ])[0].result,
    "Not Met",
  );
  assert.equal(
    screenResumeAgainstCriteria("", [{ ...rules[0], absenceFails: true }])[0]
      .result,
    "Not Assessed",
  );
  const insight = buildInsight(
    screenResumeAgainstCriteria("Barista experience", rules),
    "Barista",
    "Naga City",
  );
  assert.match(insight, /Barista in Naga City/);
  assert.doesNotMatch(insight, /should be hired|reject this|recommend hiring/i);
});
test("production reports exclude marked demo and deleted records even with real-looking names", () => {
  const state = createSeed();
  state.applications[0].isDemo = true;
  state.applications[1].deletedAt = new Date().toISOString();
  assert.equal(
    productionState(state).applications.length,
    state.applications.length - 2,
  );
  assert.ok(
    !trackerRows(state).some((r) =>
      [state.applications[0].id, state.applications[1].id].includes(r[0]),
    ),
  );
});
test("Odoo mapping detects canonical headers and calculates attendance without inventing missing time", () => {
  const mapping = detectAttendanceColumns([
    "Employee",
    "Check In",
    "Check Out",
  ]);
  assert.deepEqual(mapping, { employee: 0, checkIn: 1, checkOut: 2 });
  const rows = [
    ["Demo A", "20/09/2026 09:15", "20/09/2026 18:30"],
    ["Demo B", "20/09/2026 09:00", ""],
    ["Demo A", "20/09/2026 09:15", "20/09/2026 18:30"],
  ];
  const result = analyzeAttendance(rows, mapping, defaultAttendanceRules);
  assert.equal(result.duplicates, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].lateMinutes, 10);
  assert.equal(result.results[0].overtimeMinutes, 30);
  assert.equal(result.results[0].workedMinutes, 495);
  assert.equal(result.results[1].workedMinutes, 0);
  assert.match(result.results[1].issues.join(), /check-out/);
});
test("attendance handles overnight shifts, split sessions, invalid dates and overlaps", () => {
  const mapping = { employee: 0, checkIn: 1, checkOut: 2 };
  const night = analyzeAttendance(
    [["Demo", "2026-09-20 22:05", "2026-09-21 05:45"]],
    mapping,
    {
      ...defaultAttendanceRules,
      start: "22:00",
      end: "06:00",
      breakMinutes: 0,
    },
  );
  assert.equal(night.results[0].date, "2026-09-20");
  assert.equal(night.results[0].earlyOutMinutes, 15);
  assert.equal(night.results[0].lateMinutes, 0);
  const split = analyzeAttendance(
    [
      ["Demo", "2026-09-20 09:00", "2026-09-20 12:00"],
      ["Demo", "2026-09-20 13:00", "2026-09-20 18:00"],
    ],
    mapping,
    defaultAttendanceRules,
  );
  assert.equal(split.results[0].workedMinutes, 480);
  assert.equal(split.results[0].earlyOutMinutes, 0);
  assert.equal(
    attendanceTimestamp("31/02/2026 09:00", defaultAttendanceRules),
    null,
  );
  assert.equal(
    attendanceTimestamp("20/09/2026 25:00", defaultAttendanceRules),
    null,
  );
  assert.equal(
    attendanceTimestamp("2026-09-20T01:00:00Z", defaultAttendanceRules),
    attendanceTimestamp("20/09/2026 09:00", defaultAttendanceRules),
  );
  const overlapping = analyzeAttendance(
    [
      ["Demo", "2026-09-20 09:00", "2026-09-20 13:00"],
      ["Demo", "2026-09-20 12:00", "2026-09-20 18:00"],
    ],
    mapping,
    defaultAttendanceRules,
  );
  assert.match(overlapping.results[0].issues.join(), /Overlapping/);
  assert.equal(overlapping.results[0].workedMinutes, 0);
});
