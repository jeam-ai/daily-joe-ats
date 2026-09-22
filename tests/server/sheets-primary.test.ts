import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHmac } from "node:crypto";
import {
  requiredSheets,
  persistenceColumns,
  sheetEntity,
  sheetCells,
} from "../../lib/sheets-schema";
import {
  transaction,
  retryableTransaction,
  readTransaction,
  putRecord,
  readRecord,
} from "../../lib/server/database";
import { gatewayRequest } from "../../lib/server/sheets-gateway";
import {
  persistenceMaintenance,
  assertSourceWritable,
} from "../../lib/server/persistence-maintenance";
import {
  tableHydrationDependencies,
  workspaceHydrationTables,
} from "../../lib/server/sheets-database";

test("Sheets workspace hydration loads application parents before child records", () => {
  const parent = (table: string) =>
    workspaceHydrationTables.indexOf(table as never);
  assert.ok(parent("applicants") < parent("applications"));
  assert.ok(parent("resumes") < parent("applications"));
  assert.ok(parent("hiring_needs") < parent("applications"));
  assert.deepEqual(tableHydrationDependencies.applications, [
    "applicants",
    "resumes",
    "hiring_needs",
  ]);
  for (const child of [
    "intake_window",
    "interviews",
    "application_requirements",
    "screening_results",
    "employment_records",
    "application_events",
  ])
    assert.deepEqual(tableHydrationDependencies[child], ["applications"]);
});

test("Sheets primary persists transactions, private credentials, rollback, stale revisions and idempotent commits through the actual gateway", async () => {
  Object.assign(process.env, {
    PERSISTENCE_PROVIDER: "sheets",
    SHEETS_GATEWAY_URL: "https://script.google.com/macros/s/fixture/exec",
    SHEETS_GATEWAY_SECRET: "test-secret-".repeat(4),
  });
  const tabs = requiredSheets.map((title, i) => ({
    properties: {
      title,
      sheetId: i + 1,
      gridProperties: { rowCount: 1000, columnCount: 22 },
    },
    rows: [] as unknown[][],
  }));
  const files = new Map<string, string>();
  const fileReads = new Map<string, number>();
  let locks = 0,
    fail = false;
  const props = {
    DJC_SECRET: process.env.SHEETS_GATEWAY_SECRET,
    DJC_SPREADSHEET_ID: "fixture",
    DJC_PRIVATE_FOLDER_ID: "private",
  };
  const folder = {
    createFile(blob: { text: string }) {
      const id = crypto.randomUUID();
      files.set(id, blob.text);
      return { getId: () => id };
    },
  };
  const context = vm.createContext({
    console,
    JSON,
    Date,
    Error,
    Array,
    Number,
    String,
    Math,
    Object,
    Utilities: {
      computeHmacSha256Signature: (payload: string, key: string) => [
        ...createHmac("sha256", key).update(payload).digest(),
      ],
      getUuid: () => crypto.randomUUID(),
      newBlob: (text: string) => ({ text }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: keyof typeof props) => props[k],
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          locks++;
          return true;
        },
        releaseLock() {
          locks--;
        },
      }),
    },
    DriveApp: {
      getFolderById: () => folder,
      getFileById: (id: string) => ({
        getBlob: () => ({
          getDataAsString: () => {
            fileReads.set(id, (fileReads.get(id) || 0) + 1);
            return files.get(id);
          },
        }),
      }),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text: string) => ({
        setMimeType: () => ({ getContent: () => text, toString: () => text }),
      }),
    },
    Sheets: {
      Spreadsheets: {
        get: () => ({ sheets: tabs }),
        Values: {
          batchGet: (_id: string, { ranges }: { ranges: string[] }) => ({
            valueRanges: ranges.map((range) => ({
              values: tabs
                .find(
                  (t) => t.properties.title === range.match(/^'([^']+)'/)![1],
                )!
                .rows.slice(1),
            })),
          }),
          get: (_id: string, range: string) => {
            const title = range.match(/^'([^']+)'/)![1],
              tab = tabs.find((t) => t.properties.title === title)!;
            return {
              values: range.includes("S1")
                ? [tab.rows[0]?.slice(18, 22) || []]
                : tab.rows.slice(1),
            };
          },
        },
        batchUpdate: ({ requests }: { requests: any[] }) => {
          if (fail) throw Error("Simulated write failure");
          const staged = structuredClone(tabs);
          for (const request of requests) {
            if (request.appendDimension) {
              const t = staged.find(
                (t) => t.properties.sheetId === request.appendDimension.sheetId,
              )!;
              t.properties.gridProperties[
                request.appendDimension.dimension === "ROWS"
                  ? "rowCount"
                  : "columnCount"
              ] += request.appendDimension.length;
            }
            if (request.updateCells) {
              const u = request.updateCells,
                t = staged.find(
                  (t) => t.properties.sheetId === u.range.sheetId,
                )!;
              const row = t.rows[u.range.startRowIndex] || [];
              u.rows[0].values.forEach((v: any, i: number) => {
                row[u.range.startColumnIndex + i] =
                  v.userEnteredValue.stringValue ??
                  v.userEnteredValue.numberValue ??
                  v.userEnteredValue.boolValue;
              });
              t.rows[u.range.startRowIndex] = row;
            }
          }
          staged.forEach((v, i) => (tabs[i] = v));
        },
      },
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("../../scripts/sheets-gateway/Code.gs", import.meta.url),
      "utf8",
    ),
    context,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Response(
      context.doPost({ postData: { contents: String(init?.body) } }),
      { headers: { "Content-Type": "application/json" } },
    );
  try {
    assert.equal(
      (await gatewayRequest<{ verified: boolean }>("status")).verified,
      false,
    );
    await assert.rejects(
      readTransaction((tx) => tx.query("SELECT 1")),
      /verification/,
    );
    await gatewayRequest("commit", {
      migration: true,
      expectedRevision: 0,
      commitId: "init",
      changes: [],
      verification: { verified: true },
    });
    await transaction(async (tx) => {
      await putRecord(tx, "config", "one", { value: 1 });
      await putRecord(tx, "config", "two", { value: 2 });
      await putRecord(tx, "secure", "auth", "encrypted-fixture-token");
      await putRecord(tx, "secure", "second", "encrypted-fixture-second");
    });
    assert.deepEqual(
      await readTransaction((tx) => readRecord(tx, "config", "one")),
      { value: 1 },
    );
    assert.equal(
      await readTransaction((tx) => readRecord(tx, "secure", "auth")),
      "encrypted-fixture-token",
    );
    assert.ok(!JSON.stringify(tabs).includes("encrypted-fixture-token"));
    fileReads.clear();
    const batched = await gatewayRequest<{
      results: Record<string, unknown>[][];
    }>("loadMany", {
      queries: [
        {
          table: "records",
          collection: "config",
          tab: "Settings and Configuration",
        },
        {
          table: "records",
          collection: "secure",
          tab: "Settings and Configuration",
        },
      ],
    });
    assert.equal(batched.results[0].length, 2);
    assert.equal(batched.results[1].length, 2);
    assert.equal(batched.results[1][0].id, "auth");
    assert.ok(
      [...files.values()].some((v) => v.includes("encrypted-fixture-token")),
    );
    const privateBatches = [...files.values()].filter((v) => {
      try {
        return !!JSON.parse(v).rows;
      } catch {
        return false;
      }
    });
    assert.equal(privateBatches.length, 1);
    assert.ok(privateBatches[0].includes("encrypted-fixture-token"));
    const batchId = [...files.entries()].find(
      ([, value]) => value === privateBatches[0],
    )![0];
    assert.equal(
      fileReads.get(batchId),
      1,
      "one Drive read serves all records in the private batch",
    );
    let injectConflict = true;
    await retryableTransaction(async (tx) => {
      await putRecord(tx, "config", "retry-safe", { value: "preserved" });
      if (!injectConflict) return;
      injectConflict = false;
      const status = await gatewayRequest<{ revision: number }>("status");
      const concurrent = sheetEntity("records", {
        collection: "config",
        id: "concurrent",
        payload: '{"value":"other writer"}',
      });
      await gatewayRequest("commit", {
        expectedRevision: status.revision,
        commitId: "concurrent-write",
        changes: [{ ...concurrent, cells: sheetCells(concurrent) }],
      });
    });
    assert.deepEqual(
      await readTransaction((tx) => readRecord(tx, "config", "retry-safe")),
      { value: "preserved" },
    );
    await assert.rejects(
      transaction(async (tx) => {
        await putRecord(tx, "config", "one", { value: 99 });
        throw Error("cancelled");
      }),
      /cancelled/,
    );
    assert.deepEqual(
      await readTransaction((tx) => readRecord(tx, "config", "one")),
      { value: 1 },
    );
    fail = true;
    await assert.rejects(
      transaction((tx) => putRecord(tx, "config", "one", { value: 3 })),
      /could not complete/,
    );
    fail = false;
    assert.deepEqual(
      await readTransaction((tx) => readRecord(tx, "config", "one")),
      { value: 1 },
    );
    const status = await gatewayRequest<{ revision: number }>("status");
    const entity = sheetEntity("records", {
      collection: "config",
      id: "three",
      payload: '{"value":3}',
    });
    const commit = {
      expectedRevision: status.revision,
      commitId: "same-operation",
      changes: [{ ...entity, cells: sheetCells(entity) }],
    };
    const first = await gatewayRequest<{ revision: number }>("commit", commit),
      again = await gatewayRequest<{ revision: number }>("commit", commit);
    assert.equal(first.revision, again.revision);
    await assert.rejects(
      gatewayRequest("commit", { ...commit, commitId: "conflict" }),
      /Another update/,
    );
    assert.equal(locks, 0);
    const response = JSON.parse(
      context.doPost({
        postData: {
          contents: JSON.stringify({ payload: "{}", signature: "forged" }),
        },
      }),
    );
    assert.equal(response.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PERSISTENCE_PROVIDER;
  }
});

test("private execution refreshes only the storage client, signs requests, caches access and sanitizes provider failures", async () => {
  const before = { ...process.env },
    originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    SHEETS_GATEWAY_DEPLOYMENT_ID: "private-fixture",
    SHEETS_GATEWAY_REFRESH_TOKEN: "private-refresh",
    SHEETS_GATEWAY_CLIENT_ID: "storage-client",
    SHEETS_GATEWAY_CLIENT_SECRET: "storage-secret",
    SHEETS_GATEWAY_SECRET: "test-signing-secret-".repeat(3),
  });
  let refreshed = 0,
    calls = 0,
    failure = false;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      refreshed++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("client_id"), "storage-client");
      assert.equal(form.get("refresh_token"), "private-refresh");
      return Response.json({
        access_token: "short-lived-fixture",
        expires_in: 3600,
      });
    }
    calls++;
    assert.equal(
      String(url),
      "https://script.googleapis.com/v1/scripts/private-fixture:run",
    );
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer short-lived-fixture",
    );
    const request = JSON.parse(String(init?.body));
    assert.equal(request.function, "executeGateway");
    assert.equal(request.devMode, false);
    assert.equal(request.parameters.length, 1);
    const envelope = request.parameters[0];
    assert.match(envelope.payload, /^[\x00-\x7f]*$/);
    if (calls === 2)
      assert.equal(JSON.parse(envelope.payload).probe, "Careers — José 🟢");
    assert.equal(
      envelope.signature,
      createHmac("sha256", process.env.SHEETS_GATEWAY_SECRET!)
        .update(envelope.payload)
        .digest("hex"),
    );
    assert.ok(!String(init?.body).includes("private-refresh"));
    return Response.json(
      failure
        ? { error: { message: "private provider detail" } }
        : {
            response: {
              result: { ok: true, data: { revision: 5, verified: true } },
            },
          },
    );
  };
  try {
    assert.deepEqual(await gatewayRequest("status"), {
      revision: 5,
      verified: true,
    });
    await gatewayRequest("status", { probe: "Careers — José 🟢" });
    assert.equal(refreshed, 1);
    assert.equal(calls, 2);
    failure = true;
    await assert.rejects(
      gatewayRequest("status"),
      /gateway could not be verified/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test("migration write fence blocks ordinary writes and permits only internal maintenance or an expired lease", async () => {
  let lock: Record<string, unknown> = { expiresAt: Date.now() + 60000 };
  const tx = {
    query: async () => [{ payload: JSON.stringify(lock) }],
    execute: async () => {},
  } as unknown as import("../../lib/server/database").Transaction;
  await assert.rejects(assertSourceWritable(tx), /migration is in progress/);
  await persistenceMaintenance.run(true, () => assertSourceWritable(tx));
  lock = { expiresAt: Date.now() - 1000 };
  await assertSourceWritable(tx);
  lock = { frozen: true };
  await assert.rejects(assertSourceWritable(tx), /finish the Sheets cutover/);
});
