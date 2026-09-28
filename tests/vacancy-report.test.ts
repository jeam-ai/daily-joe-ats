import test from "node:test";
import assert from "node:assert/strict";
import {
  planVacancyReportImport,
  vacancyReport20260921,
} from "../lib/vacancy-report";
import { initialState } from "../lib/server/initial-state";
import {
  canonicalizeStoredLocations,
  nearbyConfiguredBranch,
} from "../lib/locations";
import type { Application } from "../types";

test("report keeps 18 itemized operations and 3 office slots without inventing the printed missing slot", () => {
  assert.equal(vacancyReport20260921.length, 18);
  assert.equal(
    vacancyReport20260921.slice(0, 15).reduce((sum, row) => sum + row[3], 0),
    18,
  );
  assert.equal(
    vacancyReport20260921.slice(15).reduce((sum, row) => sum + row[3], 0),
    3,
  );
  const state = initialState();
  const plan = planVacancyReportImport(state);
  assert.equal(plan.needs.length, 18);
  assert.equal(
    plan.needs.reduce((sum, need) => sum + need.slots, 0),
    21,
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
test("the previous Gen. Tri label becomes General Trias without duplicate vacancies", () => {
  const state = initialState();
  const plan = planVacancyReportImport(state);
  state.locations!.push(...plan.locations);
  state.hiringNeeds.push(...plan.needs);
  state.locations!.find((location) => location.name === "General Trias")!.name =
    "Gen. Tri";
  for (const need of state.hiringNeeds)
    if (need.location === "General Trias") need.location = "Gen. Tri";
  state.applications.push({
    location: "Gen. Tri",
    assignedBranch: "Gen. Tri",
  } as Application);
  assert.equal(planVacancyReportImport(state).needs.length, 0);
  assert.ok(canonicalizeStoredLocations(state) > 0);
  assert.equal(
    state.locations!.filter((l) => l.name === "General Trias").length,
    1,
  );
  assert.equal(
    state.hiringNeeds.filter((n) => n.location === "General Trias").length,
    2,
  );
  assert.equal(state.applications[0].location, "General Trias");
  assert.equal(state.applications[0].assignedBranch, "General Trias");
  assert.equal(canonicalizeStoredLocations(state), 0);
});

test("branch geography separates Daet and Sipocot and assigns only clear nearby residences", () => {
  const state = initialState();
  state.locations = [
    {
      id: "tagapo",
      name: "Tagapo",
      city: "",
      province: "",
      active: true,
    },
    {
      id: "washington",
      name: "Washington",
      city: "",
      province: "",
      active: true,
    },
    {
      id: "legazpi",
      name: "Legazpi",
      city: "",
      province: "",
      active: true,
    },
    {
      id: "daet-sipocot",
      name: "Daet & Sipocot",
      city: "",
      province: "",
      active: true,
    },
  ];
  state.hiringNeeds.push({
    id: "area-supervisor-daet-sipocot",
    position: "Area Supervisor",
    location: "Daet & Sipocot",
    slots: 1,
    filled: 0,
    urgency: "High",
    targetDate: "2026-10-15",
    status: "Open",
    qualifications: "",
    questions: "",
  });
  state.applications.push({
    applicant: { location: "Brgy. Tagapo, Santa Rosa, Laguna" },
    assignedBranch: "",
  } as Application);
  assert.ok(canonicalizeStoredLocations(state) > 0);
  assert.deepEqual(
    state.locations?.find((location) => location.name === "Washington"),
    {
      id: "washington",
      name: "Washington",
      city: "Legazpi City",
      province: "Albay",
      active: true,
    },
  );
  assert.ok(state.locations?.some((location) => location.name === "Daet"));
  assert.ok(state.locations?.some((location) => location.name === "Sipocot"));
  assert.equal(
    state.hiringNeeds.find((need) => need.id === "area-supervisor-daet-sipocot")
      ?.location,
    "Daet",
  );
  assert.equal(
    state.hiringNeeds.find(
      (need) => need.id === "area-supervisor-daet-sipocot-sipocot",
    )?.status,
    "Open",
  );
  assert.equal(
    state.hiringNeeds.find(
      (need) => need.id === "area-supervisor-daet-sipocot-sipocot",
    )?.targetDate,
    "2026-10-15",
  );
  assert.equal(state.applications[0].assignedBranch, "Tagapo");
  assert.equal(
    nearbyConfiguredBranch(
      "Barangay 16, Kawit East, Legazpi City, Albay",
      state.locations!,
    ),
    "Washington",
  );
  assert.equal(
    nearbyConfiguredBranch("Old Albay, Legazpi City, Albay", state.locations!),
    "Legazpi",
  );
});
