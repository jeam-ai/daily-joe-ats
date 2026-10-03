import test from "node:test";
import assert from "node:assert/strict";
import {
  applicantNavigationScope,
  cachedApplicantNavigation,
  rememberApplicantNavigation,
} from "../lib/applicant-navigation";

test("instant applicant navigation follows the filtered list across pages without leaking across users, datasets or revisions", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const scope = applicantNavigationScope(
    "status=New&page=1&sort=activity",
    "real",
    "qa@example.invalid",
    1,
  );
  const neighbors = {
    previousId: "qa-19",
    nextId: "qa-21",
    position: 21,
    total: 40,
  };
  rememberApplicantNavigation(scope, { "qa-20": neighbors });
  assert.deepEqual(
    cachedApplicantNavigation(
      applicantNavigationScope(
        "page=2&sort=activity&status=New",
        "real",
        "QA@example.invalid",
        1,
      ),
      "qa-20",
    ),
    neighbors,
  );
  for (const other of [
    applicantNavigationScope(
      "status=Rejected&sort=activity",
      "real",
      "qa@example.invalid",
      1,
    ),
    applicantNavigationScope(
      "status=New&sort=activity",
      "demo",
      "qa@example.invalid",
      1,
    ),
    applicantNavigationScope(
      "status=New&sort=activity",
      "real",
      "other@example.invalid",
      1,
    ),
    applicantNavigationScope(
      "status=New&sort=activity",
      "real",
      "qa@example.invalid",
      2,
    ),
  ])
    assert.equal(cachedApplicantNavigation(other, "qa-20"), null);
  now += 60_001;
  assert.equal(cachedApplicantNavigation(scope, "qa-20"), null);
});
