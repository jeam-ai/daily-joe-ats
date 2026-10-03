import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Application, User } from "../../types";
import { initialState } from "../../lib/server/initial-state";
import { getState, saveState } from "../../lib/server/repository";
import {
  transaction,
  readTransaction,
  putRecord,
  readRecord,
} from "../../lib/server/database";
import { listApplications } from "../../lib/server/application-list";
import { bulkApplicants } from "../../lib/server/applicant-bulk";
import { bulkIssue, bulkUpdateIssuance } from "../../lib/server/issuance-bulk";
import { bulkHiringNeeds } from "../../lib/server/hiring-needs";
import {
  previewApplicantReprocessing,
  applyApplicantReprocessing,
} from "../../lib/server/applicant-reprocessing";
import { bulkReviewAttendance, type OdooBatch } from "../../lib/server/odoo";
import { analyzeOdoo, defaultOdooRules } from "../../lib/odoo";
import { seal } from "../../lib/auth/security";
delete process.env.DATABASE_URL;
delete process.env.DATABASE_POOL_URL;
delete process.env.AIVEN_DATABASE_URL;
delete process.env.VERCEL;
Object.assign(process.env, {
  PERSISTENCE_PROVIDER: "local",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-workflow-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "QA Admin",
  role: "Admin",
  title: "HR",
  active: true,
};
function applicant(i: number): Application {
  return {
    id: `fixture-${i}`,
    applicant: {
      id: `person-${i}`,
      name: `Fixture Candidate ${i}`,
      email: `candidate${i}@example.invalid`,
      phone: "",
      location: "",
      experience: 0,
    },
    position: "Barista",
    location: i < 45 ? "Naga City" : "Santa Rosa, Laguna",
    appliedAt: "2026-09-07T00:00:00Z",
    stage: "Screening",
    status: "New",
    screening: { outcome: "Requires Review", criteria: [], completedAt: "" },
    lastActivity: "2026-09-07T00:00:00Z",
    notes: [],
    interviews: [],
    requirements: [],
    timeline: [],
    onboardingStatus: "Pending Orientation",
    source: "Gmail",
  };
}
async function seed(count = 50) {
  return transaction(async (tx) => {
    const s = initialState();
    s.applications = Array.from({ length: count }, (_, i) => applicant(i));
    await saveState(tx, s, { sync: false });
    return s;
  });
}
test("search handles interior whitespace and fractional pagination without database failures", async () => {
  await seed();
  const spaced = await listApplications(
    new URLSearchParams({ q: "  FIXTURE   Candidate  12 " }),
  );
  assert.equal(spaced.total, 1);
  assert.equal(spaced.applications[0].id, "fixture-12");
  const fractional = await listApplications(
    new URLSearchParams({ page: "1.7", limit: "2.8" }),
  );
  assert.equal(fractional.page, 1);
  assert.equal(fractional.applications.length, 2);
});

test("reprocessing rejects a contact correction that would duplicate another applicant email", async () => {
  await seed(2);
  await transaction((tx) =>
    putRecord(
      tx,
      "application_sources",
      "fixture-0",
      seal(
        {
          subject: "Application for Barista Position",
          from: "Fixture Candidate <candidate0@example.invalid>",
          body: "Full name: Fixture Candidate Zero\nEmail: candidate1@example.invalid",
        },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    ),
  );
  const before = await readTransaction(getState);
  const preview = await previewApplicantReprocessing(["fixture-0"], user);
  assert.ok(preview.changes.some((c) => c.field === "email"));
  await assert.rejects(
    applyApplicantReprocessing(preview.id, ["fixture-0:email"], false, user),
    /email.*another applicant|unique.*email/i,
  );
  const saved = await readTransaction(getState);
  assert.deepEqual(saved.applications, before.applications);
});

test("changing returned equipment back to Issued restores its stock deduction exactly once", async () => {
  await seed(1);
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.issuance = [
      {
        id: "returned-fixture",
        category: "Uniform",
        employeeName: "QA Employee",
        item: "QA Apron",
        quantity: 2,
        status: "Returned",
        issuedAt: "2026-10-01",
        returnedAt: "2026-10-02",
        signed: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ];
    state.issuanceInventory = [
      {
        id: "apron-stock",
        category: "Uniform",
        item: "QA Apron",
        beginning: 10,
        issued: 0,
        onHand: 10,
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ];
    await saveState(tx, state, { sync: false });
  });
  const input = {
    requestId: crypto.randomUUID(),
    rows: [{ id: "returned-fixture", updatedAt: "2026-10-02T00:00:00Z" }],
    operation: "status",
    status: "Issued",
    confirmed: true,
  };
  const result = await bulkUpdateIssuance(input, user);
  assert.equal(result.records[0].returnedAt, undefined);
  assert.equal(result.inventory![0].issued, 2);
  assert.equal(result.inventory![0].onHand, 8);
  assert.deepEqual(await bulkUpdateIssuance(input, user), result);
});
test("talent pool candidates return to their existing recruitment stage, while closed decisions remain protected", async () => {
  await seed(2);
  const apply = async (id: string, action: string, value = "") =>
    bulkApplicants(
      {
        requestId: crypto.randomUUID(),
        ids: [id],
        filters: "",
        revision: (await readTransaction(getState)).revision,
        action,
        value,
        reason: "QA validated",
        confirmed: true,
      },
      user,
    );
  await apply("fixture-0", "talent");
  const pooled = (await readTransaction(getState)).applications[0];
  await apply("fixture-0", "status", "New");
  const resumed = (await readTransaction(getState)).applications[0];
  assert.equal(resumed.status, "New");
  assert.equal(resumed.stage, pooled.stage);
  assert.ok(resumed.timeline.length > pooled.timeline.length);
  assert.deepEqual(resumed.notes, pooled.notes);
  await apply("fixture-1", "reject");
  await assert.rejects(
    apply("fixture-1", "status", "New"),
    /Closed application history/,
  );
  await assert.rejects(apply("fixture-1", "withdraw"), /application is closed/);
});

test("bulk applicant selection uses identical SQL filters across pages and updates only matching records", async () => {
  await seed();
  const filters = new URLSearchParams({
    q: "fixture",
    location: "Naga City",
    status: "New",
  });
  const page = await listApplications(filters);
  assert.equal(page.applications.length, 20);
  assert.equal(page.total, 45);
  const selection = await listApplications(
    new URLSearchParams({ ...Object.fromEntries(filters), selection: "ids" }),
  );
  const ids = (selection as { ids: string[] }).ids;
  assert.equal(ids.length, 45);
  const s = await readTransaction(getState);
  const input = {
    requestId: crypto.randomUUID(),
    ids,
    filters: filters.toString(),
    allFiltered: true,
    revision: s.revision,
    action: "note",
    reason: "Shared HR note",
    confirmed: true,
  };
  const result = await bulkApplicants(input, user);
  assert.equal(result.updated, 45);
  assert.deepEqual(
    await bulkApplicants(input, user),
    result,
    "retries do not append duplicate notes",
  );
  const saved = await readTransaction(getState);
  assert.equal(
    saved.applications.filter((a) => a.notes.includes("Shared HR note")).length,
    45,
  );
  assert.ok(
    saved.applications
      .filter((a) => a.location !== "Naga City")
      .every((a) => !a.notes.length),
  );
  await assert.rejects(
    bulkApplicants({ ...input, requestId: crypto.randomUUID() }, user),
    /workspace changed/i,
  );
  await assert.rejects(
    bulkApplicants(
      {
        ...input,
        revision: saved.revision,
        requestId: crypto.randomUUID(),
        ids: ["fixture-49"],
        allFiltered: false,
      },
      user,
    ),
    /selection changed/i,
  );
  await assert.rejects(
    bulkApplicants({ ...input, confirmed: false }, user),
    /Confirm/,
  );
  await assert.rejects(
    bulkApplicants(input, { ...user, role: "Viewer" }),
    /access/i,
  );
});
test("bulk deletion requires an explicit count confirmation, is reversible, and records each applicant audit", async () => {
  await seed(3);
  const s = await readTransaction(getState);
  const body = {
    requestId: crypto.randomUUID(),
    ids: s.applications.map((a) => a.id),
    filters: "",
    allFiltered: true,
    revision: s.revision,
    action: "delete",
    reason: "Duplicate import confirmed by QA",
    confirmed: true,
  };
  await assert.rejects(bulkApplicants(body, user), /DELETE 3/);
  assert.ok(
    (await readTransaction(getState)).applications.every((a) => !a.deletedAt),
  );
  await bulkApplicants({ ...body, typedConfirmation: "DELETE 3" }, user);
  assert.ok(
    (await readTransaction(getState)).applications.every(
      (a) =>
        a.deletedBy === user.email &&
        a.timeline.at(-1)?.action === "Bulk applicant action: delete",
    ),
  );
  const audits = await readTransaction((tx) =>
    tx.query(
      "SELECT application_id FROM audit_logs WHERE action='application.bulk_delete'",
    ),
  );
  assert.equal(audits.length, 3);
});

test("bulk stage changes preview every email, retain the current stage until delivery, and roll back invalid selections", async () => {
  await seed(3);
  const state = await readTransaction(getState);
  const body = {
    requestId: crypto.randomUUID(),
    ids: state.applications.map((a) => a.id),
    filters: "",
    allFiltered: true,
    revision: state.revision,
    action: "preview",
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    confirmed: true,
  };
  const preview = await bulkApplicants(body, user);
  assert.ok(
    "preview" in preview &&
      preview.preview?.every(
        (p) =>
          !p.error &&
          p.nextStage === "Initial Interview" &&
          p.recipient.endsWith("@example.invalid"),
      ),
  );
  assert.equal(
    (await readTransaction(getState)).applications[0].stage,
    "Screening",
  );
  const result = await bulkApplicants({ ...body, action: "proceed" }, user);
  assert.equal(result.emailIds.length, 3);
  assert.ok(
    (await readTransaction(getState)).applications.every(
      (a) => a.stage === "Screening" && !a.interviews.length,
    ),
  );
  const indices = await readTransaction((tx) =>
    tx.query("SELECT payload FROM records WHERE collection='email_index'"),
  );
  assert.ok(indices.length >= 3);
  const latest = await readTransaction(getState);
  await assert.rejects(
    bulkApplicants(
      {
        ...body,
        revision: latest.revision,
        requestId: crypto.randomUUID(),
        action: "delete",
        reason: "QA",
        typedConfirmation: "DELETE 3",
      },
      user,
    ),
    /pending email delivery/,
  );
  await seed(2);
  await transaction(async (tx) => {
    const s = await getState(tx);
    for (const a of s.applications) a.id = `invalid-${a.id}`;
    s.applications[1].stage = "Final Interview";
    s.applications[1].status = "In Progress";
    await saveState(tx, s, { sync: false });
  });
  const invalid = await readTransaction(getState);
  const priorCount = (
    await readTransaction((tx) =>
      tx.query("SELECT id FROM records WHERE collection='email_index'"),
    )
  ).length;
  await assert.rejects(
    bulkApplicants(
      {
        ...body,
        ids: invalid.applications.map((a) => a.id),
        revision: invalid.revision,
        requestId: crypto.randomUUID(),
        action: "proceed",
      },
      user,
    ),
    /passed interview/,
  );
  assert.equal(
    (
      await readTransaction((tx) =>
        tx.query("SELECT id FROM records WHERE collection='email_index'"),
      )
    ).length,
    priorCount,
  );
});
test("reprocessing previews existing imported data, protects manual fields, and rejects stale snapshots", async () => {
  await seed(2);
  await transaction(async (tx) => {
    const s = await getState(tx);
    s.applications[0].applicant.name = "Application for Barista Position";
    s.applications[0].information = {
      fields: {
        phone: {
          source: "HR edit",
          evidence: "HR phone",
          confidence: "Confident",
          verifiedBy: user.email,
        },
      },
      conflicts: [],
    };
    s.applications[0].applicant.phone = "09170000000";
    s.applications[1].applicant.name = "Manually Corrected Identity";
    s.applications[1].editedBy = user.email;
    await saveState(tx, s, { sync: false });
    for (const a of s.applications)
      await putRecord(
        tx,
        "application_sources",
        a.id,
        seal(
          {
            subject: "Application for Barista Position",
            from: "Juan Dela Cruz <juan@example.invalid>",
            body: "Full name: Juan Dela Cruz\nPhone: 09181112222\nApplying for: Barista",
            filename: "",
          },
          process.env.TOKEN_ENCRYPTION_KEY!,
        ),
      );
  });
  const p = await previewApplicantReprocessing(
    ["fixture-0", "fixture-1"],
    user,
  );
  const name = p.changes.find(
    (c) => c.applicationId === "fixture-0" && c.field === "name",
  )!;
  assert.equal(name.proposed, "Juan Dela Cruz");
  assert.equal(name.protected, false);
  assert.equal(
    p.changes.find(
      (c) => c.applicationId === "fixture-0" && c.field === "phone",
    )?.protected,
    true,
  );
  assert.equal(
    p.changes.find((c) => c.applicationId === "fixture-1" && c.field === "name")
      ?.protected,
    true,
  );
  assert.equal(
    (await readTransaction(getState)).applications[0].applicant.name,
    "Application for Barista Position",
    "preview is read only",
  );
  await assert.rejects(
    applyApplicantReprocessing(p.id, ["fixture-0:phone"], false, user),
    /protected/,
  );
  await applyApplicantReprocessing(p.id, ["fixture-0:name"], false, user);
  let s = await readTransaction(getState);
  assert.equal(s.applications[0].applicant.name, "Juan Dela Cruz");
  assert.equal(s.applications[0].applicant.phone, "09170000000");
  assert.equal(s.applications[1].applicant.name, "Manually Corrected Identity");
  const stale = await previewApplicantReprocessing(["fixture-0"], user);
  await transaction(async (tx) => {
    const s = await getState(tx);
    s.applications[0].notes.push("Concurrent edit");
    await saveState(tx, s, { sync: false });
  });
  await assert.rejects(
    applyApplicantReprocessing(stale.id, ["fixture-0:phone"], true, user),
    /changed after preview/,
  );
  const override = await previewApplicantReprocessing(["fixture-0"], user);
  await applyApplicantReprocessing(
    override.id,
    ["fixture-0:phone"],
    true,
    user,
  );
  s = await readTransaction(getState);
  assert.equal(s.applications[0].applicant.phone, "09181112222");
  assert.equal(
    s.applications[0].information!.fields.phone.verifiedBy,
    user.email,
  );
});
test("bulk issuance creates separate records and audits, reconciles inventory and safely replays submissions", async () => {
  await seed(30);
  await transaction(async (tx) => {
    const s = await getState(tx);
    for (const a of s.applications) {
      a.stage = "Hired";
      a.status = "Hired";
      a.hiredAt = "2026-09-08T00:00:00Z";
      a.onboardingStatus = "Completed";
      a.employment = {
        status: "Active",
        date: "2026-09-08",
        actor: user.email,
        notes: "",
      };
    }
    s.issuanceInventory = [
      {
        id: "apron-stock",
        category: "Uniform",
        item: "Apron",
        beginning: 100,
        issued: 0,
        onHand: 100,
        updatedAt: "2026-09-08T00:00:00Z",
      },
    ];
    await saveState(tx, s, { sync: false });
  });
  const body = {
    requestId: crypto.randomUUID(),
    employeeKeys: Array.from({ length: 25 }, (_, i) => `person:person-${i}`),
    category: "Uniform",
    item: "Apron",
    quantity: 2,
    issuedAt: "2026-09-08",
    issuedBy: "QA Issuer",
    condition: "New",
    notes: "Bulk handover",
    confirmed: true,
  };
  const result = await bulkIssue(body, user);
  assert.equal(result.records.length, 25);
  assert.equal(new Set(result.records.map((r) => r.id)).size, 25);
  assert.ok(
    result.records.every(
      (r) =>
        r.issuedBy === "QA Issuer" &&
        r.applicationId &&
        r.quantity === 2 &&
        r.signed === false,
    ),
  );
  assert.equal(result.inventory?.[0].issued, 50);
  assert.equal(result.inventory?.[0].onHand, 50);
  assert.deepEqual(
    (await bulkIssue(body, user)).records,
    JSON.parse(JSON.stringify(result.records)),
  );
  assert.equal((await readTransaction(getState)).issuance?.length, 25);
  assert.equal(
    (
      await readTransaction((tx) =>
        tx.query("SELECT id FROM audit_logs WHERE action='issuance.created'"),
      )
    ).length,
    25,
  );
  await assert.rejects(
    bulkIssue(
      { ...body, requestId: crypto.randomUUID(), employeeKeys: ["missing"] },
      user,
    ),
    /no longer available/,
  );
  await assert.rejects(
    bulkIssue({ ...body, confirmed: false }, user),
    /Confirm/,
  );
  assert.equal((await readTransaction(getState)).issuance?.length, 25);
  const update = {
    requestId: crypto.randomUUID(),
    rows: result.records.map((r) => ({ id: r.id, updatedAt: r.updatedAt })),
    operation: "status",
    status: "Returned",
    confirmed: true,
  };
  const returned = await bulkUpdateIssuance(update, user);
  assert.ok(
    returned.records.every((r) => r.status === "Returned" && r.returnedAt),
  );
  assert.equal(returned.inventory?.[0].onHand, 100);
  assert.equal((await bulkUpdateIssuance(update, user)).records.length, 25);
  await assert.rejects(
    bulkUpdateIssuance({ ...update, requestId: crypto.randomUUID() }, user),
    /record changed/i,
  );
});

test("bulk hiring need updates preserve qualifications and use individual audits", async () => {
  await seed(0);
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.hiringNeeds = [
      {
        id: "need-a",
        position: "Barista",
        location: "Naga City",
        slots: 2,
        filled: 0,
        urgency: "Medium",
        targetDate: "2027-01-01",
        status: "Open",
        qualifications: "",
        questions: "",
        criteria: [],
      },
      {
        id: "need-b",
        position: "Barista",
        location: "Santa Rosa",
        slots: 2,
        filled: 0,
        urgency: "Medium",
        targetDate: "2027-01-01",
        status: "Open",
        qualifications: "",
        questions: "",
        criteria: [],
      },
    ];
    await saveState(tx, state, { sync: false });
  });
  const before = await readTransaction(getState);
  const rows = before.hiringNeeds.filter((n) => !n.isDemo);
  await assert.rejects(
    bulkHiringNeeds(
      {
        ids: rows.map((n) => n.id),
        filter: "All",
        revision: before.revision,
        status: "Paused",
        confirmed: false,
      },
      user,
    ),
    /Confirm/,
  );
  const result = await bulkHiringNeeds(
    {
      ids: rows.map((n) => n.id),
      filter: "All",
      revision: before.revision,
      status: "Paused",
      confirmed: true,
    },
    user,
  );
  assert.ok(result.hiringNeeds.every((n) => n.status === "Paused"));
  for (const n of result.hiringNeeds)
    assert.deepEqual(n.criteria, rows.find((r) => r.id === n.id)!.criteria);
  await assert.rejects(
    bulkHiringNeeds(
      {
        ids: rows.map((n) => n.id),
        filter: "All",
        revision: before.revision,
        status: "Open",
        confirmed: true,
      },
      user,
    ),
    /workspace changed/,
  );
});
test("bulk attendance resolves all filtered overtime while retaining raw rows and audit history", async () => {
  const reports = {
    attendance: Array.from({ length: 30 }, (_, i) => ({
      row: i + 2,
      employee: `Employee ${i}`,
      employeeId: `e-${i}`,
      checkIn: "2026-09-07 09:00:00",
      checkOut: i < 25 ? "2026-09-07 19:13:00" : "2026-09-07 18:00:00",
      worked: i < 25 ? 10 + 13 / 60 : 9,
      overtime: 0,
      extra: 0,
      location: i < 25 ? "Naga City" : "Santa Rosa",
    })),
    pivot: Array.from({ length: 30 }, (_, i) => ({
      row: i + 2,
      employee: `Employee ${i}`,
      date: "2026-09-07",
      worked: i < 25 ? 10 + 13 / 60 : 9,
      expected: 9,
      difference: 0,
      balance: 0,
    })),
    period: { start: "2026-09-07", end: "2026-09-07", title: "Cutoff" },
    sources: [],
    warnings: [],
    aliases: [],
  };
  const analysis = analyzeOdoo(reports, defaultOdooRules),
    now = new Date().toISOString();
  const batch: OdooBatch = {
    ...analysis,
    id: "bulk-cutoff",
    revision: 1,
    uploadedBy: user.email,
    uploadedAt: now,
    analyzedAt: now,
    fingerprint: "bulk-cutoff",
  };
  await transaction((tx) =>
    putRecord(
      tx,
      "odoo_batches",
      batch.id,
      seal(batch, process.env.TOKEN_ENCRYPTION_KEY!),
    ),
  );
  const input = {
    id: batch.id,
    revision: 1,
    allFiltered: true,
    filters: {
      result: "Overtime",
      location: "Naga City",
      status: "For Review",
    },
    expectedCount: 25,
    operation: "confirm-overtime",
    note: "HR validated",
    confirmed: true,
  };
  const saved = await bulkReviewAttendance(input, user);
  assert.equal(
    saved.records.filter((r) => r.review.reviewer === user.email).length,
    25,
  );
  for (const row of saved.records.filter((r) => r.location === "Naga City")) {
    assert.equal(row.severity, "Low");
    assert.equal(row.calculation?.remainderMinutes, 13);
    assert.equal(row.calculation?.creditedMinutes, 60);
    assert.equal(row.review.history.length, 1);
    assert.deepEqual(row.raw, batch.records.find((r) => r.id === row.id)!.raw);
  }
  await assert.rejects(bulkReviewAttendance(input, user), /cutoff changed/);
  const metadata = await readTransaction((tx) =>
    readRecord(tx, "odoo_batches", batch.id),
  );
  assert.ok(metadata);
  await assert.rejects(
    bulkReviewAttendance(
      {
        ...input,
        revision: 2,
        expectedCount: 24,
        filters: { location: "Naga City" },
        operation: "note",
      },
      user,
    ),
    /selection changed/,
  );
});
