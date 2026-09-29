import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transaction, putRecord, readRecord } from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import {
  findUser,
  getState,
  publicState,
  saveState,
  updateState,
} from "../../lib/server/repository";
import { launchDemo, clearDemo } from "../../lib/server/demo";
import {
  createApplicant,
  deleteApplicant,
  restoreApplicant,
  updateApplicant,
  updateApplicantWorkflow,
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
test("configured workspace owner recovers administrator access from a legacy role", async () => {
  await transaction(async (tx) => {
    const state = initialState();
    state.users![0] = {
      ...state.users![0],
      role: "HR Generalist",
      title: "HR Associate",
    };
    await saveState(tx, state, { sync: false });
  });
  const recovered = await findUser("admin@example.invalid");
  assert.equal(recovered?.role, "Admin");
  assert.equal(recovered?.title, "Workspace Administrator");
});
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
test("profile edits do not fail because an unrelated imported record is malformed", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  const base = {
    phone: "",
    position: "Barista",
    location: "Naga City",
    notes: "",
  };
  const first = await createApplicant(
    {
      ...base,
      requestId: crypto.randomUUID(),
      name: "Editable Applicant",
      email: "editable@example.invalid",
    },
    user,
  );
  await createApplicant(
    {
      ...base,
      requestId: crypto.randomUUID(),
      name: "Older Imported Applicant",
      email: "older@example.invalid",
    },
    user,
  );
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.applications.find((item) => item.id !== first.id)!.applicant.email =
      "legacy-import-without-an-email";
    await putRecord(tx, "workspace", "main", state);
  });
  const edited = await updateApplicant(
    first.id,
    {
      ...base,
      name: "Edited Applicant",
      email: "editable@example.invalid",
      residence: "Naga City, Camarines Sur",
    },
    user,
  );
  assert.equal(edited.applicant.name, "Edited Applicant");
  assert.equal(
    (await transaction(getState)).applications.find(
      (item) => item.id === first.id,
    )?.applicant.location,
    "Naga City, Camarines Sur",
  );
});
test("HR qualification checklist saves only the applicant being reviewed", async () => {
  await transaction((tx) => putRecord(tx, "workspace", "main", initialState()));
  const base = {
    phone: "",
    position: "Barista",
    location: "Naga City",
    notes: "",
  };
  const first = await createApplicant(
    {
      ...base,
      requestId: crypto.randomUUID(),
      name: "Checklist Applicant",
      email: "checklist@example.invalid",
    },
    user,
  );
  const other = await createApplicant(
    {
      ...base,
      requestId: crypto.randomUUID(),
      name: "Legacy Applicant",
      email: "legacy@example.invalid",
    },
    user,
  );
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.applications.find(
      (application) => application.id === other.id,
    )!.applicant.email = "legacy-invalid-email";
    state.applications.find(
      (application) => application.id === first.id,
    )!.screening.criteria = [
      {
        id: "barista-experience",
        requirement: "Barista experience",
        result: "Unclear",
        evidence: "No direct text match was detected.",
      },
    ];
    await putRecord(tx, "workspace", "main", state);
  });
  const application = structuredClone(
    (await transaction(getState)).applications.find(
      (item) => item.id === first.id,
    )!,
  );
  application.screening = {
    outcome: "Meets Criteria",
    method: "hr",
    completedAt: new Date().toISOString(),
    criteria: application.screening.criteria.map((criterion) => ({
      ...criterion,
      result: "Met",
      evidence: "HR reviewed the submitted resume.",
    })),
  };
  const saved = await updateApplicantWorkflow(
    first.id,
    { application },
    user,
    true,
  );
  assert.equal(saved.screening.criteria[0].result, "Met");
  assert.equal(saved.screening.method, "hr");
  assert.match(saved.timeline.at(-1)!.action, /Qualification screening/);
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
