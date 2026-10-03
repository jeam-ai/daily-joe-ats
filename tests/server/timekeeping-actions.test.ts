import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seal } from "../../lib/auth/security";
import { defaultOdooRules, type OdooDay } from "../../lib/odoo";
import {
  completeNormalOvertimeForEmployee,
  getOdooBatch,
  reviewOdoo,
  resolveEmployeeAttendance,
  resolveZeroExpectedHours,
  type OdooBatch,
} from "../../lib/server/odoo";
import { deleteOdooCutoff } from "../../lib/server/timekeeping-delete";
import {
  putRecord,
  putRecords,
  readRecord,
  readTransaction,
  transaction,
} from "../../lib/server/database";
import { audit, getState, saveState } from "../../lib/server/repository";
import type { User } from "../../types";

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
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-timekeeping-actions-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "QA Admin",
  role: "Admin",
  title: "HR",
  active: true,
};
function record(id: string, employee: string, results = ["Overtime"]): OdooDay {
  return {
    id,
    employee,
    employeeId: employee,
    sourceNames: [employee],
    department: "",
    location: "",
    date: "2026-09-16",
    checkIn: "",
    checkOut: "",
    rawWorked: 9,
    pivotWorked: 9,
    worked: 9,
    expected: 8,
    difference: 1,
    pivotDifference: 1,
    balance: 1,
    overtime: 1,
    extra: 0,
    lateMinutes: 0,
    earlyMinutes: 0,
    results,
    issues: [],
    raw: [],
    pivot: [],
    review: {
      status: "For Review",
      note: "",
      reviewer: "",
      reviewedAt: "",
      history: [],
    },
  };
}
function batch(id: string): OdooBatch {
  return {
    id,
    version: 1,
    revision: 1,
    rules: defaultOdooRules,
    aliases: {},
    period: { start: "2026-09-16", end: "2026-09-30", title: "QA cutoff" },
    sources: [],
    warnings: [],
    records: [
      record("a", "QA A"),
      record("b", "QA B"),
      record("mixed", "QA A", ["Overtime", "Multiple Entries"]),
      record("error", "QA B", ["Overtime", "Data Discrepancy"]),
      record("excessive", "QA C", ["Excessive Overtime"]),
    ],
    uploadedBy: user.email,
    uploadedAt: "2026-09-30T00:00:00Z",
    analyzedAt: "2026-09-30T00:00:00Z",
    fingerprint: id,
  };
}
async function store(value: OdooBatch) {
  await transaction(async (tx) => {
    await putRecord(
      tx,
      "odoo_batches",
      value.id,
      seal(value, process.env.TOKEN_ENCRYPTION_KEY!),
    );
    await putRecord(tx, "odoo_index", value.id, {
      id: value.id,
      period: value.period,
      flagged: value.records.filter((row) => row.review.status === "For Review")
        .length,
    });
    await putRecord(
      tx,
      "odoo_cutoffs",
      `${value.period.start}:${value.period.end}`,
      value.id,
    );
    await putRecord(tx, "odoo_fingerprints", value.fingerprint, value.id);
  });
}
test("cutoff mass completion includes all employees and persists only single-classification Overtime", async () => {
  const original = batch("mass");
  original.records.push(
    ...Array.from({ length: 250 }, (_, i) => record(`extra-${i}`, `QA ${i}`)),
  );
  await store(original);
  await assert.rejects(
    completeNormalOvertimeForEmployee(
      { id: original.id, revision: 1, scope: "cutoff", note: "QA" },
      { ...user, role: "Viewer" },
    ),
    /access/,
  );
  const saved = await completeNormalOvertimeForEmployee(
    {
      id: original.id,
      revision: 1,
      scope: "cutoff",
      note: "QA separate monitoring",
    },
    user,
  );
  assert.equal(saved.revision, 2);
  assert.equal(
    saved.records.filter((row) => row.review.status === "Resolved").length,
    252,
  );
  for (const id of ["mixed", "error", "excessive"])
    assert.deepEqual(
      saved.records.find((row) => row.id === id),
      original.records.find((row) => row.id === id),
    );
  assert.equal(
    (await getOdooBatch(saved.id, user)).records[1].review.history[0].next,
    "Resolved",
  );
  const counts = await readTransaction(async (tx) => ({
    reviews: await tx.query(
      "SELECT id FROM records WHERE collection='odoo_reviews'",
    ),
    index: await readRecord<{ flagged: number }>(tx, "odoo_index", saved.id),
  }));
  assert.equal(counts.reviews.length, 252);
  assert.equal(counts.index!.flagged, 3);
  await assert.rejects(
    completeNormalOvertimeForEmployee(
      { id: saved.id, revision: 1, scope: "cutoff", note: "QA" },
      user,
    ),
    /Another HR user/,
  );
  await assert.rejects(
    completeNormalOvertimeForEmployee(
      { id: saved.id, revision: 2, scope: "cutoff", note: "QA" },
      user,
    ),
    /No overtime-only/,
  );
});
test("employee completion rejects mixed tags and records belonging to another employee atomically", async () => {
  const value = batch("employee");
  await store(value);
  for (const recordIds of [
    ["a", "mixed"],
    ["a", "b"],
  ]) {
    await assert.rejects(
      completeNormalOvertimeForEmployee(
        {
          id: value.id,
          revision: 1,
          employeeKey: "QA A",
          recordIds,
          note: "QA",
        },
        user,
      ),
      /exactly one classification/,
    );
    assert.equal((await getOdooBatch(value.id, user)).revision, 1);
  }
  const saved = await completeNormalOvertimeForEmployee(
    {
      id: value.id,
      revision: 1,
      employeeKey: "QA A",
      recordIds: ["a"],
      note: "QA",
    },
    user,
  );
  assert.equal(saved.records[0].review.status, "Resolved");
  assert.equal(saved.records[1].review.status, "For Review");
});
test("single attendance review leaves unrelated exception projections untouched", async () => {
  const value = batch("single");
  await store(value);
  await transaction((tx) =>
    putRecord(tx, "odoo_exceptions", `${value.id}:b`, {
      sentinel: "unchanged",
    }),
  );
  await reviewOdoo(
    {
      id: value.id,
      revision: 1,
      recordId: "a",
      status: "Resolved",
      note: "QA",
    },
    user,
  );
  assert.deepEqual(
    await readTransaction((tx) =>
      readRecord(tx, "odoo_exceptions", `${value.id}:b`),
    ),
    { sentinel: "unchanged" },
  );
});

test("a correction can be saved without verification or Odoo correction notes", async () => {
  const value = batch("optional-notes");
  await store(value);
  const saved = await reviewOdoo(
    {
      id: value.id,
      revision: 1,
      recordId: "a",
      status: "Resolved",
      correctedInOdoo: true,
    },
    user,
  );
  assert.equal(saved.records[0].review.note, "");
  assert.equal(saved.records[0].review.correctionNote, "");
  assert.equal(saved.records[0].review.correctedInOdoo, true);
  assert.equal(saved.records[0].review.history.length, 1);
});

test("keeping the main duplicate entry removes extras, recalculates hours and persists correction evidence", async () => {
  const value = batch("duplicates");
  const row = value.records[2];
  row.raw = [2, 3].map((sourceRow) => ({
    row: sourceRow,
    employee: "QA A",
    employeeId: "QA A",
    checkIn: "2026-09-16 08:00:00",
    checkOut: "2026-09-16 17:00:00",
    worked: 9,
    overtime: 1,
    extra: 0,
  }));
  row.pivot = [
    {
      row: 2,
      employee: "QA A",
      date: row.date,
      worked: 9,
      expected: 8,
      difference: 1,
      balance: 1,
    },
  ];
  row.worked = 18;
  row.results.push("Excessive Overtime");
  await store(value);
  await assert.rejects(
    reviewOdoo(
      {
        id: value.id,
        revision: 1,
        recordId: row.id,
        status: "Resolved",
        duplicateResolution: {
          retainedSourceRows: [2],
          disregardedSourceRows: [],
        },
      },
      user,
    ),
    /every entry/,
  );
  const saved = await reviewOdoo(
    {
      id: value.id,
      revision: 1,
      recordId: row.id,
      status: "Resolved",
      duplicateResolution: {
        retainedSourceRows: [2],
        disregardedSourceRows: [3],
      },
    },
    user,
  );
  const corrected = saved.records[2];
  assert.equal(corrected.raw.length, 1);
  assert.equal(corrected.raw[0].row, 2);
  assert.equal(corrected.worked, 9);
  assert.ok(!corrected.results.includes("Multiple Entries"));
  assert.ok(!corrected.results.includes("Excessive Overtime"));
  assert.ok(corrected.results.includes("Normal"));
  assert.equal(
    corrected.review.duplicateResolution!.disregardedRecords![0].row,
    3,
  );
  assert.deepEqual(
    (await getOdooBatch(value.id, user)).records[2],
    JSON.parse(JSON.stringify(corrected)),
  );
});

test("employee bulk resolution is atomic, scoped to one employee and still requires ambiguous classifications", async () => {
  const value = batch("resolve-employee");
  value.records[2].results = ["No Attendance"];
  await store(value);
  for (const records of [
    [{ recordId: "a" }, { recordId: "b" }],
    [{ recordId: "a" }, { recordId: "mixed" }],
  ]) {
    await assert.rejects(
      resolveEmployeeAttendance(
        { id: value.id, revision: 1, employeeKey: "QA A", records },
        user,
      ),
      /same employee|classification/,
    );
    assert.equal((await getOdooBatch(value.id, user)).revision, 1);
  }
  const saved = await resolveEmployeeAttendance(
    {
      id: value.id,
      revision: 1,
      employeeKey: "QA A",
      records: [
        { recordId: "a" },
        { recordId: "mixed", classification: "Absent" },
      ],
    },
    user,
  );
  assert.equal(saved.revision, 2);
  assert.equal(saved.records[0].review.status, "Resolved");
  assert.equal(saved.records[2].review.status, "Resolved");
  assert.equal(saved.records[2].review.classification, "Absent");
  assert.equal(saved.records[1].review.status, "For Review");
  assert.equal(saved.records[0].review.note, "");
  const index = await readTransaction((tx) =>
    readRecord<{ flagged: number }>(tx, "odoo_index", value.id),
  );
  assert.equal(index!.flagged, 3);
  await assert.rejects(
    resolveEmployeeAttendance(
      {
        id: value.id,
        revision: 1,
        employeeKey: "QA A",
        records: [{ recordId: "a" }],
      },
      user,
    ),
    /Another HR user/,
  );
});

test("zero expected hours completion excludes zero worked hours and mixed attendance errors", async () => {
  const value = batch("zero-expected");
  const system = "System Error — Expected hours missing or zero";
  const raw = {
    row: 2,
    employee: "QA A",
    checkIn: "2026-09-16 08:00:00",
    checkOut: "2026-09-16 17:00:00",
    worked: 9,
    overtime: 1,
    extra: 0,
  };
  value.records[0] = {
    ...value.records[0],
    expected: 0,
    results: [system, "Overtime"],
    raw: [raw],
  };
  value.records[1] = {
    ...value.records[1],
    expected: 0,
    worked: 0,
    results: [system],
    raw: [raw],
  };
  value.records[2] = {
    ...value.records[2],
    expected: 0,
    results: [system, "Missing Time Out"],
    raw: [raw],
  };
  value.records[3].worked = 0;
  await store(value);
  await assert.rejects(
    resolveZeroExpectedHours(
      { id: value.id, revision: 1 },
      { ...user, role: "Viewer" },
    ),
    /access/,
  );
  const saved = await resolveZeroExpectedHours(
    {
      id: value.id,
      revision: 1,
      note: "Expected-hours formula error verified",
    },
    user,
  );
  assert.equal(saved.records[0].review.status, "Resolved");
  assert.equal(saved.records[0].review.classification, "System / Data Issue");
  assert.equal(
    saved.records[0].review.note,
    "Expected-hours formula error verified",
  );
  assert.equal(saved.records[0].expected, 0);
  assert.equal(saved.records[0].worked, 9);
  for (const row of saved.records.slice(1))
    assert.equal(row.review.status, "For Review");
  await assert.rejects(
    resolveZeroExpectedHours({ id: value.id, revision: 1 }, user),
    /Another HR user/,
  );
  await assert.rejects(
    resolveZeroExpectedHours({ id: value.id, revision: 2 }, user),
    /No zero expected hours/,
  );
});
test("bulk writes reduce 450 database round trips to three bounded upserts", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  await putRecords(
    {
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        return [];
      },
    },
    "odoo_exceptions",
    Array.from({ length: 450 }, (_, i) => ({ id: String(i), value: { i } })),
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.values.length),
    [600, 600, 150],
  );
});
test("permanent cutoff deletion removes versions, reviews, processing inputs and pointers while preserving other cutoffs", async () => {
  const value = batch("delete");
  value.previousBatchId = "old-delete";
  await store(value);
  const other = batch("keep");
  other.period = {
    start: "2026-10-01",
    end: "2026-10-15",
    title: "Other cutoff",
  };
  await store(other);
  await transaction(async (tx) => {
    await putRecord(tx, "odoo_reviews", "old-review", {
      batchId: "old-delete",
      note: "QA confidential review",
    });
    await putRecord(tx, "odoo_exceptions", "delete:a", { batchId: value.id });
    await putRecord(tx, "timekeeping_jobs", "finished", {
      id: "finished",
      kind: "analyze",
      status: "Completed",
      result: { batchId: value.id },
    });
    await putRecord(
      tx,
      "timekeeping_inputs",
      "finished",
      seal(
        { id: "preview", cutoff: value.period },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
    await putRecord(tx, "odoo_uploads", "preview", "fictional input");
    const state = await getState(tx);
    state.notifications.push({
      id: `timekeeping-${value.id}`,
      title: "QA",
      description: "QA",
      href: `/timekeeping?batch=${value.id}`,
      date: value.analyzedAt,
      read: false,
    });
    await saveState(tx, state, { sync: false });
    await audit(tx, user.email, "timekeeping.analyzed", undefined, {
      id: value.id,
      cutoff: `${value.period.start}:${value.period.end}`,
      replacedBatchId: "old-delete",
    });
  });
  await assert.rejects(
    deleteOdooCutoff({ id: value.id, revision: 1 }, user),
    /Confirm permanent/,
  );
  await assert.rejects(
    deleteOdooCutoff({ id: value.id, revision: 2, confirmed: true }, user),
    /changed/,
  );
  await assert.rejects(
    deleteOdooCutoff(
      { id: value.id, revision: 1, confirmed: true },
      { ...user, role: "Viewer" },
    ),
    /access/,
  );
  assert.deepEqual(
    await deleteOdooCutoff(
      { id: value.id, revision: 1, confirmed: true },
      user,
    ),
    { deleted: value.id },
  );
  await assert.rejects(getOdooBatch(value.id, user), /not found/);
  assert.equal((await getOdooBatch(other.id, user)).id, other.id);
  await readTransaction(async (tx) => {
    for (const [collection, id] of [
      ["odoo_index", "delete"],
      ["odoo_fingerprints", "delete"],
      ["odoo_cutoffs", "2026-09-16:2026-09-30"],
      ["odoo_reviews", "old-review"],
      ["odoo_exceptions", "delete:a"],
      ["timekeeping_jobs", "finished"],
      ["timekeeping_inputs", "finished"],
      ["odoo_uploads", "preview"],
    ])
      assert.equal(await readRecord(tx, collection, id), null, collection);
    assert.equal(
      (await getState(tx)).notifications.some(
        (notification) => notification.id === "timekeeping-delete",
      ),
      false,
    );
    const logs = await tx.query(
      "SELECT payload FROM audit_logs WHERE action='timekeeping.cutoff_deleted'",
    );
    assert.equal(logs.length, 1);
    assert.equal(
      String(logs[0].payload).includes("confidential review"),
      false,
    );
  });
});
test("deletion refuses a queued analysis for the same cutoff to avoid recreating deleted data", async () => {
  const value = batch("busy-delete");
  await store(value);
  await transaction(async (tx) => {
    await putRecord(tx, "timekeeping_jobs", "pending", {
      id: "pending",
      kind: "analyze",
      status: "Queued",
    });
    await putRecord(
      tx,
      "timekeeping_inputs",
      "pending",
      seal(
        { id: "pending-preview", cutoff: value.period },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
  });
  await assert.rejects(
    deleteOdooCutoff({ id: value.id, revision: 1, confirmed: true }, user),
    /processing to finish/,
  );
  assert.equal((await getOdooBatch(value.id, user)).id, value.id);
});
