import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord, readRecord } from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import {
  getState,
  publicState,
  updateState,
} from "../../lib/server/repository";
import { launchDemo, clearDemo } from "../../lib/server/demo";
import {
  createApplicant,
  deleteApplicant,
  restoreApplicant,
} from "../../lib/server/applicants";
import { trackerRows } from "../../lib/tracker";
import { detectResumeType, extractResume } from "../../lib/server/documents";
import type { User } from "../../types";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
process.env.GOOGLE_ALLOWED_EMAIL = "admin@example.invalid";
process.env.OFFICIAL_CAREERS_EMAIL = "careers@example.invalid";
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-polish-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "Demo HR",
  role: "Admin",
  active: true,
  title: "HR",
};
test("demo lifecycle, soft deletion, restoration, audit, and production isolation", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  const values = {
    requestId: crypto.randomUUID(),
    name: "Real-looking Test Fixture",
    email: "fixture@example.invalid",
    phone: "",
    position: "Barista",
    location: "Naga City",
    notes: "Test fixture only",
  };
  const created = await createApplicant(values, user);
  assert.deepEqual(
    await createApplicant(values, user),
    created,
    "creation retries must be idempotent",
  );
  const original = structuredClone((await publicState(user)).applications[0]);
  let externalCalls = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    externalCalls++;
    throw Error("No external calls allowed");
  };
  try {
    assert.equal((await transaction((tx) => launchDemo(tx, user))).imported, 5);
    assert.equal((await transaction((tx) => launchDemo(tx, user))).imported, 0);
    let state = await publicState(user);
    assert.equal(state.applications.filter((a) => a.isDemo).length, 5);
    assert.equal(state.hiringNeeds.filter((n) => n.isDemo).length, 3);
    assert.equal(
      new Set(state.applications.filter((a) => a.isDemo).map((a) => a.stage))
        .size,
      5,
    );
    assert.deepEqual(
      state.applications.find((a) => a.id === original.id),
      original,
    );
    assert.equal(trackerRows(state).length, 1);
    const demoSettingsChange = structuredClone(state);
    demoSettingsChange.intakeQuery = "subject:changed";
    await assert.rejects(
      updateState(demoSettingsChange, user, true, "demo"),
      /Exit Demo/,
    );
    const demoRealChange = structuredClone(state);
    demoRealChange.applications
      .find((a) => !a.isDemo)!
      .notes.push("Must not persist");
    await assert.rejects(
      updateState(demoRealChange, user, true, "demo"),
      /Exit Demo/,
    );
    const forged = structuredClone(state);
    forged.applications[0].isDemo = true;
    await assert.rejects(updateState(forged, user, true), /source history/);
    const mixed = structuredClone(state);
    mixed.applications[0].hiringNeedId = state.hiringNeeds.find(
      (n) => n.isDemo,
    )!.id;
    await assert.rejects(
      updateState(mixed, user, true),
      /same real or demo dataset/,
    );
    state.preferences.theme = "dark";
    state = await updateState(state, user, false, "demo");
    assert.deepEqual(
      state.applications.find((a) => a.id === original.id),
      original,
      "preference saves must not rewrite applicant history",
    );
    assert.equal(state.syncStatus, "unchanged");
    state.applications.find((a) => a.isDemo)!.notes.push("Demo-only edit");
    state = await updateState(state, user, false, "demo");
    assert.deepEqual(
      state.applications.find((a) => a.id === original.id),
      original,
      "demo edits must not modify real applicants",
    );
    assert.equal(
      state.syncStatus,
      "unchanged",
      "demo edits must not queue production sync",
    );
    assert.equal((await transaction((tx) => clearDemo(tx, user))).removed, 5);
    state = await publicState(user);
    assert.equal(state.applications.length, 1);
    assert.equal(state.hiringNeeds.length, 0);
    const residual = await transaction(async (tx) => ({
      apps: await tx.query("SELECT id FROM applications"),
      interviews: await tx.query("SELECT id FROM interviews"),
      needs: await tx.query("SELECT id FROM hiring_needs"),
    }));
    assert.equal(residual.apps.length, 1);
    assert.equal(residual.interviews.length, 0);
    assert.equal(residual.needs.length, 0);
    await assert.rejects(
      deleteApplicant(original.id, { confirmed: true }, user),
      /Type the applicant ID/,
    );
    await assert.rejects(
      deleteApplicant(
        original.id,
        { confirmed: true, typedId: original.id },
        { ...user, role: "Viewer" },
      ),
      /recruitment manager/,
    );
    state.applications[0].applicant.name = "Edited Fixture";
    state = await updateState(state, user, true);
    assert.equal(state.applications[0].applicant.name, "Edited Fixture");
    assert.match(
      state.applications[0].timeline.at(-1)!.metadata.previous,
      /Real-looking/,
    );
    await deleteApplicant(
      original.id,
      { confirmed: true, typedId: original.id, reason: "Regression test" },
      user,
    );
    assert.equal((await publicState(user)).applications.length, 0);
    let stored = await transaction(getState);
    assert.equal(stored.applications[0].deletedBy, user.email);
    state = await publicState(user);
    state.preferences.compact = true;
    await updateState(state, user, false);
    stored = await transaction(getState);
    assert.equal(
      stored.applications.length,
      1,
      "ordinary saves must retain hidden records",
    );
    await assert.rejects(
      restoreApplicant(original.id, { ...user, role: "HR Generalist" }),
      /Administrator/,
    );
    await restoreApplicant(original.id, user);
    assert.equal((await publicState(user)).applications.length, 1);
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});
test("resume detection rejects renamed executable content and reports unreadable input", async () => {
  assert.throws(
    () => detectResumeType(Buffer.from("MZ..."), "resume.pdf"),
    /Unsupported or invalid/,
  );
  assert.throws(
    () => detectResumeType(Buffer.alloc(8 * 1024 * 1024 + 1), "resume.png"),
    /8 MB/,
  );
  const result = await extractResume(Buffer.from("Short resume"), "resume.txt");
  assert.equal(result.extraction.method, "text");
  assert.ok(result.extraction.warnings.length);
  assert.equal(result.text, "Short resume");
});
