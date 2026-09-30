import test from "node:test";
import assert from "node:assert/strict";
import { readTransaction, transaction } from "../../lib/server/database";
import { withStore } from "../../lib/server/store";
import { seal } from "../../lib/auth/security";
import { isDatabaseFailure } from "../../lib/server/diagnostic-buffer";

Object.assign(process.env, {
  PERSISTENCE_PROVIDER: "postgres",
  DATABASE_URL: "postgres://fixture:fixture@database.example.invalid/fixture",
  GOOGLE_CLIENT_ID: "fixture",
  GOOGLE_CLIENT_SECRET: "fixture",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  APP_ORIGIN: "http://localhost:3000",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
});
delete process.env.AIVEN_DATABASE_URL;
delete process.env.DATABASE_POOL_URL;
delete process.env.AIVEN_CA_CERT;
delete process.env.VERCEL;
const db = globalThis as typeof globalThis & {
  djPool?: unknown;
  djSchemaReady?: Promise<void>;
};
const failure = (code: string) =>
  Object.assign(new Error("Fixture interruption"), { code });

function fixture(
  constraints = ["applications_stage_valid", "applications_status_valid"],
) {
  const queries: string[] = [];
  const releases: boolean[] = [];
  let sessionFailures = 0;
  let brokenRollback = false;
  const encrypted = seal(
    { sessions: {}, events: [], requests: {} },
    process.env.TOKEN_ENCRYPTION_KEY!,
  );
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql === "ROLLBACK" && brokenRollback) throw failure("ECONNRESET");
      if (sql.includes("SELECT payload FROM records") && sessionFailures-- > 0)
        throw failure("ECONNRESET");
      return {
        rows: sql.includes("SELECT payload FROM records")
          ? [{ payload: JSON.stringify(encrypted) }]
          : [],
      };
    },
    release(destroy: boolean) {
      releases.push(destroy);
    },
  };
  db.djPool = {
    async query(sql: string, values: string[] = []) {
      queries.push(sql);
      if (sql.startsWith("SELECT to_regclass"))
        return {
          rows: [Object.fromEntries(values.map((_, i) => [`r${i}`, true]))],
        };
      if (sql.startsWith("SELECT conname"))
        return { rows: constraints.map((conname) => ({ conname })) };
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  db.djSchemaReady = undefined;
  return {
    queries,
    releases,
    interruptSession() {
      sessionFailures = 1;
    },
    breakRollback() {
      brokenRollback = true;
    },
  };
}

test("a migrated PostgreSQL cold start performs catalog reads without taking DDL table locks", async () => {
  const pg = fixture();
  assert.equal(await readTransaction(async () => "ready"), "ready");
  assert.ok(pg.queries.some((sql) => sql.startsWith("SELECT conname")));
  assert.equal(
    pg.queries.some((sql) => /CREATE |ALTER |DO \$\$/.test(sql)),
    false,
  );
  assert.equal(
    pg.queries.some((sql) => sql.includes("pg_advisory_xact_lock")),
    false,
  );
  const catalogReads = pg.queries.filter((sql) =>
    sql.startsWith("SELECT to_regclass"),
  ).length;
  await readTransaction(async () => "ready");
  assert.deepEqual(pg.releases, [false, false]);
  assert.equal(
    pg.queries.filter((sql) => sql.startsWith("SELECT to_regclass")).length,
    catalogReads,
  );
});

test("an older PostgreSQL schema still applies its required constraint migrations", async () => {
  const pg = fixture(["applications_gmail_thread_id_key"]);
  await readTransaction(async () => "ready");
  assert.ok(
    pg.queries.some((sql) =>
      sql.startsWith("ALTER TABLE applications DROP CONSTRAINT"),
    ),
  );
  assert.ok(
    pg.queries.some((sql) =>
      sql.includes("ADD CONSTRAINT applications_stage_valid"),
    ),
  );
});

test("session reads recover a short database disconnect without writing authentication data", async () => {
  const pg = fixture();
  pg.interruptSession();
  assert.equal(await withStore((store) => store.events.length, false), 0);
  assert.equal(pg.queries.filter((sql) => sql.startsWith("BEGIN")).length, 2);
  assert.equal(
    pg.queries.some((sql) =>
      /INSERT|UPDATE|DELETE|pg_advisory_xact_lock/.test(sql),
    ),
    false,
  );
});

test("a failed rollback preserves the original database error for recovery", async () => {
  const pg = fixture();
  pg.breakRollback();
  const original = failure("57014");
  await assert.rejects(
    transaction(async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(pg.releases, [true]);
});

test("connection, lock and serialization interruptions are recoverable; invalid SQL and data are not", () => {
  for (const code of [
    "08006",
    "53300",
    "57P01",
    "40001",
    "40P01",
    "55P03",
    "57014",
    "ECONNRESET",
  ])
    assert.equal(isDatabaseFailure(failure(code)), true, code);
  for (const code of ["23505", "23514", "42P01", "42501"])
    assert.equal(isDatabaseFailure(failure(code)), false, code);
});
