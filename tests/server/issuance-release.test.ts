import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importIssuanceWorkbook } from "../../app/api/issuance/route";
import {
  transaction,
  readTransaction,
  readRecord,
} from "../../lib/server/database";
import { getState, saveState } from "../../lib/server/repository";
import type { IssuanceRecord } from "../../types";

delete process.env.DATABASE_URL;
delete process.env.DATABASE_POOL_URL;
delete process.env.AIVEN_DATABASE_URL;
delete process.env.VERCEL;
Object.assign(process.env, {
  PERSISTENCE_PROVIDER: "local",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-issuance-release-")));
async function workbook() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("UPDATED MONITORING (UNIFORM)").addRows([
    [
      "Released Date",
      "Name",
      "Description",
      "QTY",
      "Received Date",
      "Store Name",
    ],
    ["2026-10-01", "FICTIONAL Released", "QA Cap", 2, "", "QA Branch"],
    ["", "FICTIONAL Pending", "QA Cap", 1, "", "QA Branch"],
  ]);
  return new File(
    [new Uint8Array(await book.xlsx.writeBuffer())],
    "QA-Uniform.xlsx",
  );
}
test("workbook release dates produce Issued records without inventing received dates and reconcile stock", async () => {
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.issuance = [];
    state.issuanceInventory = [
      {
        id: "qa-cap",
        category: "Uniform",
        item: "QA Cap",
        beginning: 10,
        issued: 0,
        onHand: 10,
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ];
    await saveState(tx, state, { sync: false });
  });
  const result = await importIssuanceWorkbook(
    await workbook(),
    "admin@example.invalid",
  );
  assert.equal(result.created, 2);
  await readTransaction(async (tx) => {
    const state = await getState(tx);
    const released = state.issuance!.find(
      (record) => record.employeeName === "FICTIONAL Released",
    )!;
    assert.equal(released.status, "Issued");
    assert.equal(released.receivedAt, undefined);
    assert.equal(
      state.issuance!.find(
        (record) => record.employeeName === "FICTIONAL Pending",
      )!.status,
      "Pending",
    );
    assert.equal(state.issuanceInventory![0].issued, 2);
    assert.equal(state.issuanceInventory![0].onHand, 8);
    const rows = await tx.query(
      "SELECT payload FROM employee_issuance WHERE id=$1",
      [released.id],
    );
    assert.equal(
      (JSON.parse(String(rows[0].payload)) as IssuanceRecord).status,
      "Issued",
    );
  });
});
test("reimport corrects an existing dated Pending record once and preserves exceptional statuses", async () => {
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.issuance!.find(
      (record) => record.employeeName === "FICTIONAL Released",
    )!.status = "Pending";
    await saveState(tx, state, { sync: false });
  });
  const corrected = await importIssuanceWorkbook(
    await workbook(),
    "admin@example.invalid",
  );
  assert.equal(corrected.created, 0);
  assert.equal(corrected.releasesUpdated, 1);
  const unchanged = await importIssuanceWorkbook(
    await workbook(),
    "admin@example.invalid",
  );
  assert.equal(unchanged.releasesUpdated, 0);
  await transaction(async (tx) => {
    const state = await getState(tx);
    state.issuance!.find(
      (record) => record.employeeName === "FICTIONAL Released",
    )!.status = "Returned";
    await saveState(tx, state, { sync: false });
  });
  const returned = await importIssuanceWorkbook(
    await workbook(),
    "admin@example.invalid",
  );
  assert.equal(returned.releasesUpdated, 0);
  assert.equal(
    await readTransaction(
      async (tx) =>
        (await getState(tx)).issuance!.find(
          (record) => record.employeeName === "FICTIONAL Released",
        )!.status,
    ),
    "Returned",
  );
  assert.ok(await readTransaction((tx) => readRecord(tx, "workspace", "main")));
});
