import test from "node:test";
import assert from "node:assert/strict";
import {
  planVacancyReportImport,
  vacancyReport20260921,
} from "../lib/vacancy-report";
import { initialState } from "../lib/server/initial-state";

test("report keeps 18 itemized operations and 2 office slots without inventing the printed missing slot", () => {
  assert.equal(vacancyReport20260921.length, 17);
  assert.equal(
    vacancyReport20260921.slice(0, 15).reduce((sum, row) => sum + row[3], 0),
    18,
  );
  assert.equal(
    vacancyReport20260921.slice(15).reduce((sum, row) => sum + row[3], 0),
    2,
  );
  const state = initialState();
  const plan = planVacancyReportImport(state);
  assert.equal(plan.needs.length, 17);
  assert.equal(
    plan.needs.reduce((sum, need) => sum + need.slots, 0),
    20,
  );
  assert.ok(plan.needs.every((need) => need.targetDate === "2026-10-15"));
  assert.ok(
    plan.needs.every((need) =>
      need.criteria?.every(
        (criterion) =>
          criterion.kind === "Preferred" && !criterion.absenceFails,
      ),
    ),
  );
  state.locations!.push(...plan.locations);
  state.hiringNeeds.push(...plan.needs);
  assert.equal(planVacancyReportImport(state).needs.length, 0);
  assert.equal(planVacancyReportImport(state).locations.length, 0);
});
