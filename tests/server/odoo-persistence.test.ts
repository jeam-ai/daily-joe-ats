import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  previewOdoo,
  analyzeOdooUpload,
  getOdooBatch,
  listOdooBatches,
  reviewOdoo,
  exportOdoo,
} from "../../lib/server/odoo";
import { defaultOdooRules } from "../../lib/odoo";
import { readRecord, readTransaction } from "../../lib/server/database";
import { unseal } from "../../lib/auth/security";
import type { User } from "../../types";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
Object.assign(process.env, {
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: "b".repeat(64),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-odoo-")));
const user: User = {
  id: "admin@example.invalid",
  email: "admin@example.invalid",
  name: "QA Admin",
  role: "Admin",
  title: "HR",
  active: true,
};
async function file(name: string, rows: unknown[][]) {
  const b = new ExcelJS.Workbook();
  b.addWorksheet("Report").addRows(rows);
  return { name, bytes: Buffer.from(await b.xlsx.writeBuffer()) };
}
test("combined Odoo uploads persist reviews, deduplicate exact reports, version changed rules and export auditable results", async () => {
  const raw = await file("Attendance.xlsx", [
    [
      "Employee",
      "Check In",
      "Check Out",
      "Worked Hours",
      "Over Time",
      "Extra Hours",
    ],
    ["DEMO Example", "2026-09-01 09:00:00", "2026-09-01 16:00:00", 7, 0, 0],
    ["DEMO Example", "2026-09-02 09:00:00", "", 0, 0, 0],
    ["DEMO Example", "2026-09-03 09:00:00", "2026-09-03 17:00:00", 8, 0, 0],
  ]);
  const pivot = await file("Pivot.xlsx", [
    [null, "September 2026"],
    [null, "Worked Hours", "Expected Hours", "Difference", "Balance"],
    ["DEMO Example", 15, 24, -9, -9],
    ["01 Sep 2026", 7, 8, -1, -1],
    ["02 Sep 2026", 0, 8, -8, -8],
    ["03 Sep 2026", 8, 8, 0, 0],
  ]);
  await assert.rejects(
    previewOdoo(raw, pivot, { ...user, role: "Viewer" }),
    /access/,
  );
  const p = await previewOdoo(raw, pivot, user),
    b = await analyzeOdooUpload(p.id, defaultOdooRules, {}, user);
  const previewPayload = await readTransaction((tx) =>
    readRecord<string>(tx, "odoo_uploads", p.id),
  );
  assert.equal(previewPayload, null);
  const reviewed = await reviewOdoo(
    {
      id: b.id,
      recordId: b.records[0].id,
      revision: b.revision,
      status: "Excused",
      note: "Fictional fixture: approved schedule adjustment.",
    },
    user,
  );
  assert.equal(reviewed.records[0].review.history[0].previous, "For Review");
  assert.equal(
    (await getOdooBatch(b.id, user)).records[0].review.reviewer,
    user.email,
  );
  await assert.rejects(
    reviewOdoo(
      {
        id: b.id,
        recordId: b.records[0].id,
        revision: b.revision,
        status: "Resolved",
        note: "Stale",
      },
      user,
    ),
    /Another HR user/,
  );
  const again = await previewOdoo(raw, pivot, user),
    same = await analyzeOdooUpload(again.id, defaultOdooRules, {}, user);
  assert.equal(same.id, b.id);
  assert.equal(same.records[0].review.status, "Excused");
  const changed = await analyzeOdooUpload(
    again.id,
    { ...defaultOdooRules, discrepancyMinutes: 2 },
    {},
    user,
  );
  assert.notEqual(changed.id, b.id);
  assert.equal(changed.previousBatchId, b.id);
  assert.deepEqual(
    (await listOdooBatches(user)).map((item) => item.id),
    [changed.id],
  );
  await assert.rejects(getOdooBatch(b.id, user), /Analysis not found/);
  assert.equal(
    (
      await readTransaction((tx) =>
        tx.query(
          "SELECT id FROM records WHERE collection='odoo_reviews' AND payload LIKE $1",
          [`%\"batchId\":\"${b.id}\"%`],
        ),
      )
    ).length,
    0,
  );
  const xlsx = await exportOdoo(reviewed, false),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx as never);
  assert.equal(book.getWorksheet("Attendance review")!.rowCount, 4);
  assert.equal(book.worksheets[0].name, "Summary");
  assert.ok(book.getWorksheet("Exceptions"));
  assert.ok(book.getWorksheet("Multiple Entries"));
  assert.ok(book.getWorksheet("Source and rules"));
  assert.equal(
    book.getWorksheet("Attendance review")!.getRow(1).getCell(6).text,
    "Check In (Asia/Manila)",
  );
  assert.match(
    book.getWorksheet("Attendance review")!.getRow(2).getCell(6).text,
    /September 1, 2026.*9:00:00 AM/,
  );
  assert.equal(
    book.getWorksheet("Attendance review")!.getRow(2).getCell(17).text,
    "Excused",
  );
  assert.match(
    (await exportOdoo(reviewed, true)).toString(),
    /approved schedule adjustment/,
  );
});

test("explicit payroll dates identify a cutoff even when its edge days have no entries", async () => {
  const raw = await file("Attendance.xlsx", [
    [
      "Employee",
      "Check In",
      "Check Out",
      "Worked Hours",
      "Over Time",
      "Extra Hours",
    ],
    ["QA Example", "2026-09-02 09:00:00", "2026-09-02 17:00:00", 8, 0, 0],
  ]);
  const pivot = await file("Pivot.xlsx", [
    [null, "September 2026"],
    [null, "Worked Hours", "Expected Hours", "Difference", "Balance"],
    ["QA Example", 8, 8, 0, 0],
    ["02 Sep 2026", 8, 8, 0, 0],
  ]);
  const first = await previewOdoo(raw, pivot, user);
  const encrypted = await readTransaction((tx) =>
    readRecord<string>(tx, "odoo_uploads", first.id),
  );
  const stored = unseal<Record<string, unknown>>(
    encrypted!,
    process.env.TOKEN_ENCRYPTION_KEY!,
  );
  assert.equal("files" in stored, false);
  await assert.rejects(
    analyzeOdooUpload(first.id, defaultOdooRules, {}, user, undefined, {
      start: "2026-09-03",
      end: "2026-09-15",
    }),
    /include every dated record/,
  );
  const cutoff = { start: "2026-09-01", end: "2026-09-15" };
  const saved = await analyzeOdooUpload(
    first.id,
    defaultOdooRules,
    {},
    user,
    undefined,
    cutoff,
  );
  assert.equal(saved.period.start, cutoff.start);
  assert.equal(saved.period.end, cutoff.end);
  const second = await previewOdoo(raw, pivot, user);
  const replacement = await analyzeOdooUpload(
    second.id,
    { ...defaultOdooRules, discrepancyMinutes: 2 },
    {},
    user,
    undefined,
    cutoff,
  );
  assert.equal(replacement.previousBatchId, saved.id);
  const active = await listOdooBatches(user);
  assert.equal(
    active.filter(
      (item) =>
        item.period.start === cutoff.start && item.period.end === cutoff.end,
    ).length,
    1,
  );
  assert.equal(
    active.find(
      (item) =>
        item.period.start === cutoff.start && item.period.end === cutoff.end,
    )?.id,
    replacement.id,
  );
  await assert.rejects(getOdooBatch(saved.id, user), /Analysis not found/);
});
