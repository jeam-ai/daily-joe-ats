import { bufferFailure, isDatabaseFailure } from "./diagnostic-buffer";
import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SafeError } from "./config";
import { sheetsPrimary } from "./sheets-gateway";
import { sheetsTransaction } from "./sheets-database";
import { assertSourceWritable } from "./persistence-maintenance";

type Row = Record<string, unknown>;
export interface Transaction {
  query(sql: string, values?: unknown[]): Promise<Row[]>;
}
const globalDb = globalThis as typeof globalThis & {
  djSqlite?: DatabaseSync;
  djPool?: Pool;
  djDbQueue?: Promise<unknown>;
  djSchemaReady?: Promise<void>;
};
const schema = [
  "CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(collection,id))",
  "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, application_id TEXT, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS audit_time_idx ON audit_logs(occurred_at)",
  "CREATE INDEX IF NOT EXISTS audit_entity_time_idx ON audit_logs(application_id,occurred_at)",
  "CREATE INDEX IF NOT EXISTS audit_action_time_idx ON audit_logs(action,occurred_at)",
  "CREATE TABLE IF NOT EXISTS resumes (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, content TEXT NOT NULL, extracted_text TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS applicants (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hiring_needs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL REFERENCES applicants(id), hiring_need_id TEXT REFERENCES hiring_needs(id), resume_id TEXT REFERENCES resumes(id), gmail_message_id TEXT UNIQUE, gmail_thread_id TEXT UNIQUE, stage TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS intake_window (application_id TEXT PRIMARY KEY REFERENCES applications(id), state TEXT NOT NULL, received_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS intake_window_order ON intake_window(state,received_at,application_id)",
  "CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS application_requirements (id TEXT NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id), payload TEXT NOT NULL, PRIMARY KEY(id,application_id))",
  "CREATE TABLE IF NOT EXISTS screening_results (application_id TEXT PRIMARY KEY REFERENCES applications(id), payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS employment_records (application_id TEXT PRIMARY KEY REFERENCES applications(id), hired_at TEXT NOT NULL, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS application_events (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), occurred_at TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL)",
  ...[
    "qualification_templates",
    "requirements",
    "email_templates",
    "locations",
    "notifications",
  ].map(
    (name) =>
      `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  ),
];
// SQLite is durable on this local host. Serverless deployments require the
// verified Sheets gateway or PostgreSQL; ephemeral local files are never primary.
async function databaseTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: { readOnly?: boolean; lockKey?: number } = {},
): Promise<T> {
  if (sheetsPrimary()) return sheetsTransaction(schema, fn, !!options.readOnly);
  if (
    process.env.DATABASE_URL &&
    process.env.PERSISTENCE_PROVIDER !== "local"
  ) {
    if (!globalDb.djPool) {
      globalDb.djPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
        query_timeout: 35000,
        idle_in_transaction_session_timeout: 60000,
      });
      // Idle provider disconnects must not become uncaught process exceptions.
      globalDb.djPool.on("error", () => bufferFailure("database.unavailable"));
    }
    // Existing deployments need a catalog read, not DDL locks on every cold
    // start. CREATE ... IF NOT EXISTS still takes relation locks in PostgreSQL.
    globalDb.djSchemaReady ||= (async () => {
      const names = schema.map(
        (sql) => sql.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/)![1],
      );
      const present = await globalDb.djPool!.query(
        "SELECT " +
          names.map((_, i) => `to_regclass($${i + 1}) AS r${i}`).join(","),
        names,
      );
      if (!Object.values(present.rows[0]).every(Boolean))
        await globalDb.djPool!.query(schema.join("; "));
    })().catch((error) => {
      globalDb.djSchemaReady = undefined;
      throw error;
    });
    await globalDb.djSchemaReady;
    const client = await globalDb.djPool.connect();
    try {
      await client.query(
        options.readOnly
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : "BEGIN",
      );
      if (!options.readOnly)
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          options.lockKey ?? 812901,
        ]);
      const tx: Transaction = {
        query: async (sql, values = []) =>
          (await client.query(sql, values)).rows,
      };
      if (!options.readOnly) await assertSourceWritable(tx);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  if (process.env.VERCEL)
    throw new SafeError(
      "Configure verified Google Sheets persistence before deploying. Local storage is not supported on Vercel.",
      503,
    );
  const run = (globalDb.djDbQueue || Promise.resolve()).then(async () => {
    if (!globalDb.djSqlite) {
      await mkdir(path.join(process.cwd(), ".data"), {
        recursive: true,
        mode: 0o700,
      });
      const filename = process.env.LOCAL_DATABASE_FILE || "careers.sqlite";
      if (!/^[a-zA-Z0-9_-]+\.sqlite$/.test(filename))
        throw new SafeError("Invalid local storage filename.", 503);
      globalDb.djSqlite = new DatabaseSync(
        path.join(process.cwd(), ".data", filename),
      );
      globalDb.djSqlite.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;",
      );
      for (const sql of schema) globalDb.djSqlite.exec(sql);
    }
    const db = globalDb.djSqlite;
    for (const sql of schema) db.exec(sql);
    db.exec("BEGIN IMMEDIATE");
    try {
      const tx: Transaction = {
        query: async (sql, values = []) => {
          const order: number[] = [];
          const statement = db.prepare(
            sql.replace(/\$(\d+)/g, (_, n) => {
              order.push(Number(n) - 1);
              return "?";
            }),
          );
          const args = order.map((i) => values[i] as string | number | null);
          return /^\s*SELECT/i.test(sql)
            ? (statement.all(...args) as Row[])
            : (statement.run(...args), []);
        },
      };
      if (!options.readOnly) await assertSourceWritable(tx);
      const result = await fn(tx);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  globalDb.djDbQueue = run.catch(() => undefined);
  return run;
}
export async function transaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: { readOnly?: boolean; lockKey?: number } = {},
) {
  try {
    return await databaseTransaction(fn, options);
  } catch (error) {
    if (isDatabaseFailure(error)) bufferFailure("database.unavailable");
    throw error;
  }
}
// MVCC readers do not wait behind recruitment imports. Mutations retain the
// shared advisory lock and commit the workspace and relational tables together.
export function readTransaction<T>(fn: (tx: Transaction) => Promise<T>) {
  return transaction(fn, { readOnly: true });
}
export async function readRecord<T>(
  tx: Transaction,
  collection: string,
  id: string,
): Promise<T | null> {
  const rows = await tx.query(
    "SELECT payload FROM records WHERE collection=$1 AND id=$2",
    [collection, id],
  );
  return rows[0] ? (JSON.parse(String(rows[0].payload)) as T) : null;
}
export async function putRecord(
  tx: Transaction,
  collection: string,
  id: string,
  value: unknown,
) {
  await tx.query(
    "INSERT INTO records(collection,id,payload) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload",
    [collection, id, JSON.stringify(value)],
  );
}
