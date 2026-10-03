import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, assertEditor } from "../../lib/domain";
import type { User } from "../../types";
import { safeError } from "../../lib/server/response";

test("expected workflow validation returns actionable 400 feedback without internal diagnostics", async () => {
  const response = safeError(
    new DomainError("Set orientation and commitment dates."),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Set orientation and commitment dates.",
  });
});
test("workflow authorization remains 403 when converting expected domain errors", async () => {
  const user: User = {
    id: "viewer",
    email: "viewer@example.invalid",
    name: "Viewer",
    role: "Viewer",
    active: true,
    title: "QA",
  };
  let error;
  try {
    assertEditor(user);
  } catch (e) {
    error = e;
  }
  const response = safeError(error);
  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error,
    "Your account has read-only access.",
  );
});
