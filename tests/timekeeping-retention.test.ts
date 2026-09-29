import assert from "node:assert/strict";
import test from "node:test";
import {
  timekeepingCutoffExpiresAt,
  timekeepingRetentionLabel,
} from "../lib/timekeeping-retention";

test("both monthly timekeeping cutoffs expire after the next payroll date plus grace", () => {
  assert.equal(
    timekeepingCutoffExpiresAt("2026-09-15"),
    "2026-10-10T23:59:59.999Z",
  );
  assert.equal(
    timekeepingCutoffExpiresAt("2026-09-30"),
    "2026-10-10T23:59:59.999Z",
  );
  assert.equal(
    timekeepingCutoffExpiresAt("2026-12-31"),
    "2027-01-10T23:59:59.999Z",
  );
});

test("timekeeping cutoff retention rejects invalid dates and explains the payroll grace", () => {
  assert.equal(timekeepingCutoffExpiresAt("2026-02-30"), null);
  assert.match(timekeepingRetentionLabel(5), /5th.*5 grace days/i);
});
