import test from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../lib/mock/seed";
import { transition, nextStage, renderTemplate } from "../lib/recruitment";
test("fixtures are fictional and cover every requested application state", () => {
  const { applications } = createSeed();
  assert.ok(
    applications.every((a) => a.applicant.email.endsWith("@example.com")),
  );
  for (const status of [
    "New",
    "For Review",
    "Hired",
    "Rejected",
    "Withdrawn",
    "No Response",
    "Talent Pool",
  ])
    assert.ok(applications.some((a) => a.status === status));
  for (const stage of [
    "Screening",
    "Initial Interview",
    "Final Interview",
    "Requirements",
    "Onboarding",
    "Hired",
  ])
    assert.ok(applications.some((a) => a.stage === stage));
});
test("consequential decisions require confirmation and leave the original record unchanged", () => {
  const a = createSeed().applications[0];
  assert.throws(() => transition(a, "Reject", { confirmed: false }));
  assert.equal(a.status, "New");
  const rejected = transition(a, "Reject", { confirmed: true });
  assert.equal(rejected.status, "Rejected");
  assert.equal(a.status, "New");
  assert.equal(
    rejected.timeline.at(-1)?.metadata.communication,
    "No email sent",
  );
});
test("interview transition requires a future schedule and creates an audit event", () => {
  const a = createSeed().applications[0];
  assert.equal(nextStage(a), "Initial Interview");
  assert.throws(() => transition(a, "Proceed", { confirmed: true }));
  assert.throws(() =>
    transition(a, "Proceed", { confirmed: true, scheduledAt: "invalid-date" }),
  );
  assert.throws(() =>
    transition(a, "Proceed", { confirmed: true, scheduledAt: "2020-01-01" }),
  );
  const moved = transition(a, "Proceed", {
    confirmed: true,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(moved.stage, "Initial Interview");
  assert.equal(moved.interviews.length, 1);
  assert.equal(moved.timeline.length, a.timeline.length + 1);
});
test("no-response applications are reviewed rather than silently rejected", () => {
  const a = createSeed().applications.find((a) => a.status === "No Response")!;
  assert.equal(a.status, "No Response");
  assert.equal(
    transition(a, "Review", { confirmed: true }).status,
    "For Review",
  );
});
test("hiring requires HR verified requirements and completed onboarding", () => {
  const a = createSeed().applications.find((a) => a.stage === "Onboarding")!;
  assert.throws(() => transition(a, "Proceed", { confirmed: true }));
  const ready = {
    ...a,
    requirements: a.requirements.map((r) => ({
      ...r,
      status: "Complete" as const,
    })),
    onboardingStatus: "Completed" as const,
  };
  const hired = transition(ready, "Proceed", { confirmed: true });
  assert.equal(hired.status, "Hired");
  assert.ok(hired.hiredAt);
  assert.throws(() => transition(hired, "Reject", { confirmed: true }));
});
test("communication template variables resolve without dropping unknown placeholders", () =>
  assert.equal(
    renderTemplate("Hello {{applicant_name}}, {{unknown}}", {
      applicant_name: "Fictional Person",
    }),
    "Hello Fictional Person, {{unknown}}",
  ));
