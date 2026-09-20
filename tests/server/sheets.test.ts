import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncSheets } from "../../lib/google/sheets";
import { withStore } from "../../lib/server/store";
import { transaction, putRecord } from "../../lib/server/database";
import { initialState } from "../../lib/server/initial-state";
import { demoDataset } from "../../lib/server/demo";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  GOOGLE_SHEETS_ID: "test-sheet",
});
process.chdir(mkdtempSync(path.join(tmpdir(), "djc-sheets-")));
test("Sheets applies formatting once, excludes demo data and mirrors stable rows without duplicates", async () => {
  const state = initialState(),
    data = demoDataset(state, "admin@example.invalid");
  state.applications = data.applications;
  state.hiringNeeds = data.hiringNeeds;
  await transaction((tx) => putRecord(tx, "workspace", "main", state));
  await withStore((s) => {
    s.sheetsConnection = {
      email: "admin@example.invalid",
      accessToken: "synthetic-token",
      expiresAt: Date.now() + 3600000,
      connectedAt: new Date().toISOString(),
    };
  });
  const originalFetch = globalThis.fetch;
  let formattingCalls = 0,
    valuesCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.ok(init?.signal, "Every remote call has a timeout signal");
    if (String(url).includes("fields=sheets.properties"))
      return Response.json({
        sheets: [
          {
            properties: {
              sheetId: 7,
              title: "ATS Tracker",
              gridProperties: { rowCount: 1000, columnCount: 26 },
            },
          },
        ],
      });
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith(":batchUpdate")) {
      formattingCalls++;
      assert.equal(
        body.requests[0].updateSheetProperties.properties.gridProperties
          .frozenRowCount,
        1,
      );
      assert.equal(body.requests[1].repeatCell.range.sheetId, 7);
    } else {
      valuesCalls++;
      assert.equal(init?.method, "PUT");
      assert.equal(body.values.length, 101);
      assert.equal(body.values[0].length, 24);
      assert.ok(
        body.values
          .slice(1)
          .every((row: string[]) => row.every((cell) => cell === "")),
        "No demo applicant can enter the production sheet",
      );
    }
    return Response.json({});
  };
  try {
    assert.equal(await syncSheets(), "Google Sheets synchronized.");
    assert.equal(await syncSheets(), "Google Sheets synchronized.");
    assert.equal(formattingCalls, 1);
    assert.equal(valuesCalls, 2);
    globalThis.fetch = async () =>
      new Response("Private upstream failure", { status: 500 });
    assert.match(await syncSheets(), /^Failed to synchronize/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
