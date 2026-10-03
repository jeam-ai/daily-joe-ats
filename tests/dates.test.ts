import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, monthStartIso, scheduledIso } from "../lib/dates";
test("business dates and monthly filters stay in the saved timezone across midnight and month/year boundaries", () => {
  assert.equal(dayKey("2026-09-30T17:30:00Z"), "2026-10-01");
  assert.equal(dayKey("2026-09-30T17:30:00Z", "UTC"), "2026-09-30");
  assert.equal(dayKey("2026-12-31T16:00:00Z"), "2027-01-01");
  assert.equal(
    monthStartIso("2026-09-30T17:30:00Z"),
    "2026-09-30T16:00:00.000Z",
  );
  assert.equal(
    monthStartIso("2026-09-30T17:30:00Z", "UTC"),
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(scheduledIso("2026-10-01T00:00"), "2026-09-30T16:00:00.000Z");
});
test("interview date conversion rejects impossible calendar dates and times", () => {
  for (const value of [
    "2026-02-31T08:00",
    "2026-13-01T08:00",
    "2026-10-01T24:00",
    "2026-10-01T08:60",
    "bad input",
  ])
    assert.throws(() => scheduledIso(value), /valid interview date/);
  assert.equal(scheduledIso("2028-02-29T08:00"), "2028-02-29T00:00:00.000Z");
});
