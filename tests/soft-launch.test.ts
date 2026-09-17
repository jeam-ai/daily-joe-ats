import test from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "../lib/mock/seed";
import {
  validateApplicationChange,
  assertEditor,
  deriveNotifications,
  stateSchema,
} from "../lib/domain";
import { transition } from "../lib/recruitment";
import { buildEmailPayload } from "../lib/google/gmail/payload";
import { trackerHeaders, trackerRows } from "../lib/tracker";
import type { User } from "../types";
test("server workflow rejects unconfirmed decisions and stage skipping", () => {
  const a = createSeed().applications[0];
  assert.throws(
    () => validateApplicationChange(a, { ...a, status: "Rejected" }, false),
    /Confirm/,
  );
  assert.throws(
    () =>
      validateApplicationChange(
        a,
        { ...a, stage: "Hired", status: "Hired" },
        true,
      ),
    /order/,
  );
});
test("an interview must be passed in a separate HR action before proceeding", () => {
  const a = transition(createSeed().applications[0], "Proceed", {
    confirmed: true,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.throws(
    () =>
      transition(a, "Proceed", {
        confirmed: true,
        scheduledAt: new Date(Date.now() + 172800000).toISOString(),
      }),
    /passed interview/,
  );
  const passed = {
    ...a,
    interviews: a.interviews.map((i) => ({ ...i, status: "Passed" as const })),
  };
  const next = transition(passed, "Proceed", {
    confirmed: true,
    scheduledAt: new Date(Date.now() + 172800000).toISOString(),
  });
  assert.doesNotThrow(() => validateApplicationChange(passed, next, true));
});
test("imported identity, source, notes and hired history cannot be erased", () => {
  const a = createSeed().applications[0];
  assert.throws(
    () =>
      validateApplicationChange(
        a,
        { ...a, applicant: { ...a.applicant, email: "tampered@example.com" } },
        true,
      ),
    /identity/,
  );
  const b = { ...a, notes: ["Historical note"] };
  assert.throws(
    () => validateApplicationChange(b, { ...b, notes: [] }, true),
    /Historical/,
  );
  const hired = {
    ...a,
    hiredAt: "2026-09-01T00:00:00.000Z",
    status: "Hired" as const,
    stage: "Hired" as const,
  };
  assert.throws(
    () =>
      validateApplicationChange(
        hired,
        { ...hired, hiredAt: "2026-09-02T00:00:00.000Z" },
        true,
      ),
    /original hired date/,
  );
});
test("screening cannot silently invent criteria", () => {
  const a = createSeed().applications[0];
  assert.throws(
    () =>
      validateApplicationChange(
        a,
        { ...a, screening: { ...a.screening, criteria: [] } },
        true,
      ),
    /assigned HR criteria/,
  );
});
test("Viewer cannot edit and Office Assistant requires assignment", () => {
  const user: User = {
    id: "user",
    email: "viewer@example.com",
    name: "Viewer",
    title: "Reviewer",
    role: "Viewer",
    active: true,
  };
  assert.throws(() => assertEditor(user));
  const office = { ...user, role: "Office Assistant" as const };
  assert.throws(() => assertEditor(office, createSeed().applications[0]));
  assert.doesNotThrow(() =>
    assertEditor(office, {
      ...createSeed().applications[0],
      assignedTo: office.email,
    }),
  );
});
test("tracker includes stable applicant IDs and all 24 requested columns", () => {
  const state = createSeed(),
    row = trackerRows(state)[0];
  assert.equal(trackerHeaders.length, 24);
  assert.equal(row.length, 24);
  assert.equal(row[0], state.applications[0].id);
  assert.equal(row[2], state.applications[0].applicant.email);
});
test("thread reply sets Gmail thread and safe RFC reply headers", () => {
  const payload = buildEmailPayload({
    to: "candidate@example.com",
    subject: "Application",
    body: "Hello",
    threadId: "thread-1",
    inReplyTo: "<application@example.com>",
  });
  assert.equal(payload.threadId, "thread-1");
  const mime = Buffer.from(payload.raw, "base64url").toString();
  assert.match(mime, /In-Reply-To: <application@example.com>/);
  assert.throws(() =>
    buildEmailPayload({
      to: "candidate@example.com",
      subject: "Application",
      body: "Hello",
      inReplyTo: "<x@y>\r\nBcc: injected@example.com",
    }),
  );
});
test("notifications derive from actual records and do not change decisions", () => {
  const state = createSeed();
  state.applications = [];
  state.hiringNeeds = [];
  assert.deepEqual(deriveNotifications(state), []);
  const a = createSeed().applications[0];
  state.applications = [a];
  const original = JSON.stringify(a);
  const notices = deriveNotifications(state);
  assert.ok(notices.some((n) => n.title === "Application needs review"));
  assert.equal(JSON.stringify(a), original);
});
test("state schema rejects capacity overflow and malformed users", () => {
  const state = createSeed();
  assert.equal(
    stateSchema.safeParse({ ...state, importLimit: 101 }).success,
    false,
  );
  assert.equal(
    stateSchema.safeParse({
      ...state,
      users: [{ email: "not-email", role: "Admin" }],
    }).success,
    false,
  );
});
