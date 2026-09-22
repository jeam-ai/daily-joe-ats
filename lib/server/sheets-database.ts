import "server-only";
import { DatabaseSync } from "node:sqlite";
import {
  entitySheets,
  collectionSheets,
  databaseColumns,
  databaseTables,
  sheetEntity,
  sheetCells,
  recordKey,
  type DatabaseRow,
  type PersistedEntity,
} from "@/lib/sheets-schema";
import { gatewayRequest } from "./sheets-gateway";
import { SafeError } from "./config";
import type { Transaction } from "./database";

const stateKeys: Record<string, string> = {
  applications: "applications",
  hiringNeeds: "hiring_needs",
  qualifications: "qualification_templates",
  emailTemplates: "email_templates",
  requirementTemplates: "requirements",
  locations: "locations",
  notifications: "notifications",
  users: "users",
};
// The primary-sheet adapter uses SQLite to preserve the established repository
// contract. Load relational parents before applications so a cold start can
// hydrate records without bypassing foreign-key checks.
export const workspaceHydrationTables = [
  "applicants",
  "resumes",
  "hiring_needs",
  "applications",
  "qualification_templates",
  "email_templates",
  "requirements",
  "locations",
  "notifications",
  "users",
] as const;
// A cold serverless instance may execute a narrow query (for example a count
// from Applications) before the workspace projection is read. Load every
// relational parent first so the local SQLite adapter keeps foreign-key
// validation enabled while hydrating Sheets rows.
export const tableHydrationDependencies: Record<string, readonly string[]> = {
  applications: ["applicants", "resumes", "hiring_needs"],
  intake_window: ["applications"],
  interviews: ["applications"],
  application_requirements: ["applications"],
  screening_results: ["applications"],
  employment_records: ["applications"],
  application_events: ["applications"],
};
function hydrationPrerequisites(table: string) {
  const ordered: string[] = [],
    seen = new Set<string>();
  const visit = (candidate: string) => {
    for (const dependency of tableHydrationDependencies[candidate] || []) {
      if (seen.has(dependency)) continue;
      visit(dependency);
      seen.add(dependency);
      ordered.push(dependency);
    }
  };
  visit(table);
  return ordered;
}
type Cache = {
  db: DatabaseSync;
  revision: number;
  loaded: Set<string>;
  checkedAt: number;
  verified: boolean;
};
const globalSheets = globalThis as typeof globalThis & {
  djcSheetsCache?: Cache;
  djcSheetsQueue?: Promise<unknown>;
};
const tabFor = (table: string, collection?: string) =>
  table === "records"
    ? collection
      ? collectionSheets[collection] || "Settings and Configuration"
      : undefined
    : entitySheets[table];
export function persistedRow(table: string, row: DatabaseRow): DatabaseRow {
  const result = { ...row };
  if (table === "records" && row.collection === "workspace") {
    const value = JSON.parse(String(row.payload));
    Object.keys(stateKeys).forEach((k) => delete value[k]);
    result.payload = JSON.stringify({ ...value, persistenceProjection: 1 });
  }
  return result;
}
function entities(db: DatabaseSync) {
  const rows = new Map<string, PersistedEntity>(),
    demos = new Set<string>(),
    applicants = new Set<string>();
  for (const row of db
    .prepare("SELECT * FROM applications")
    .all() as DatabaseRow[]) {
    const a = JSON.parse(String(row.payload));
    if (a.isDemo || a.source === "Demo") {
      demos.add(String(row.id));
      applicants.add(String(row.applicant_id));
    }
  }
  for (const table of databaseTables)
    for (const row of db
      .prepare(`SELECT * FROM ${table}`)
      .all() as DatabaseRow[]) {
      const e = sheetEntity(table, persistedRow(table, row));
      if (
        demos.has(String(row.application_id)) ||
        demos.has(String(row.id)) ||
        applicants.has(String(row.id)) ||
        (table === "records" &&
          [
            "tracker",
            "import_previews",
            "application_sources",
            "timekeeping_inputs",
            "odoo_sources",
            "odoo_uploads",
            "secure",
            "email_drafts",
            "email_outbox",
            "ai_runs",
            "extraction_results",
          ].includes(String(row.collection)))
      )
        e.private = true;
      rows.set(e.key, e);
    }
  return rows;
}
export async function sheetsTransaction<T>(
  schema: string[],
  fn: (tx: Transaction) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const run = (globalSheets.djcSheetsQueue || Promise.resolve()).then(
    async () => {
      let cache = globalSheets.djcSheetsCache;
      if (!cache || !readOnly || Date.now() - cache.checkedAt > 10000) {
        const remote = await gatewayRequest<{
          revision: number;
          verified: boolean;
        }>("status");
        if (!remote.verified)
          throw new SafeError(
            "Sheets migration has not passed verification. Cutover is blocked; restore source access and finish verification first.",
            503,
          );
        if (!cache || cache.revision !== remote.revision) {
          cache?.db.close();
          const db = new DatabaseSync(":memory:");
          for (const sql of schema) db.exec(sql);
          cache = {
            db,
            revision: remote.revision,
            loaded: new Set(),
            checkedAt: Date.now(),
            verified: true,
          };
          globalSheets.djcSheetsCache = cache;
        } else cache.checkedAt = Date.now();
      }
      const current = cache!,
        db = current.db;
      const original = entities(db);
      let baseline = false;
      async function load(
        table: string,
        collection?: string,
        id?: string,
        metadataOnly = false,
        prefetched?: { revision: number; rows: DatabaseRow[] },
      ) {
        const scope = JSON.stringify([
          table,
          collection || "",
          id || "",
          metadataOnly,
        ]);
        if (
          current.loaded.has(scope) ||
          current.loaded.has(
            JSON.stringify([table, collection || "", "", false]),
          )
        )
          return;
        // The first authenticated page load needs the workspace projection,
        // its relational rows, and the two diagnostic collections. Fetch them
        // from one immutable gateway snapshot so a cold serverless instance
        // does not spend several Apps Script executions hydrating one page or
        // observe a different revision between those reads.
        if (!prefetched && table === "records" && collection === "workspace") {
          const queries = [
              {
                table: "records",
                tab: tabFor("records", "workspace"),
                collection: "workspace",
                id,
              },
              ...workspaceHydrationTables.map((candidate) => ({
                table: candidate,
                tab: tabFor(candidate),
                metadataOnly: candidate === "resumes",
              })),
              ...["diagnostics", "diagnostic_reads"].map((candidate) => ({
                table: "records",
                tab: tabFor("records", candidate),
                collection: candidate,
              })),
            ],
            batch = await gatewayRequest<{
              revision: number;
              results: DatabaseRow[][];
            }>("loadMany", { queries });
          await load(table, collection, id, metadataOnly, {
            revision: batch.revision,
            rows: batch.results[0],
          });
          for (let i = 0; i < workspaceHydrationTables.length; i++) {
            const candidate = workspaceHydrationTables[i];
            await load(
              candidate,
              undefined,
              undefined,
              candidate === "resumes",
              { revision: batch.revision, rows: batch.results[i + 1] },
            );
          }
          for (let i = 0; i < 2; i++) {
            const candidate = ["diagnostics", "diagnostic_reads"][i];
            await load("records", candidate, undefined, false, {
              revision: batch.revision,
              rows: batch.results[workspaceHydrationTables.length + i + 1],
            });
          }
          return;
        }
        const prerequisites = hydrationPrerequisites(table).filter(
          (dependency) =>
            !current.loaded.has(
              JSON.stringify([dependency, "", "", dependency === "resumes"]),
            ),
        );
        if (prerequisites.length && !prefetched) {
          const pending = [...prerequisites, table],
            batch = await gatewayRequest<{
              revision: number;
              results: DatabaseRow[][];
            }>("loadMany", {
              queries: pending.map((candidate) => ({
                table: candidate,
                tab: tabFor(candidate),
                metadataOnly: candidate === "resumes",
              })),
            });
          for (let i = 0; i < prerequisites.length; i++)
            await load(
              prerequisites[i],
              undefined,
              undefined,
              prerequisites[i] === "resumes",
              { revision: batch.revision, rows: batch.results[i] },
            );
          return load(table, collection, id, metadataOnly, {
            revision: batch.revision,
            rows: batch.results[pending.length - 1],
          });
        }
        // Prefetched workspace batches are already dependency ordered. This
        // fallback preserves correctness if a future caller supplies a child
        // table alone.
        for (const dependency of prerequisites)
          await load(
            dependency,
            undefined,
            undefined,
            dependency === "resumes",
          );
        const result =
          prefetched ||
          (await gatewayRequest<{
            revision: number;
            rows: DatabaseRow[];
          }>("load", {
            table,
            tab: tabFor(table, collection),
            tabs:
              table === "records" && !collection
                ? [
                    ...new Set([
                      ...Object.values(collectionSheets),
                      "Settings and Configuration",
                    ]),
                  ]
                : undefined,
            collection,
            id,
            metadataOnly,
          }));
        if (result.revision !== current.revision) {
          globalSheets.djcSheetsCache = undefined;
          throw new SafeError(
            "Records changed while loading. Refresh and try again.",
            409,
          );
        }
        const beforeLoad = entities(db);
        for (const row of result.rows) {
          const columns = Object.keys(row);
          const invalidColumn = columns.find(
            (column) => !databaseColumns[table].includes(column),
          );
          if (invalidColumn)
            throw new SafeError(
              "Spreadsheet record structure needs review.",
              503,
            );
          const missing: DatabaseRow =
            table === "resumes" && metadataOnly
              ? { content: "", extracted_text: "" }
              : {};
          const full: DatabaseRow = { ...missing, ...row };
          const keys = Object.keys(full);
          db.prepare(
            `INSERT OR ${table === "resumes" && !metadataOnly ? "REPLACE" : "IGNORE"} INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ).run(...keys.map((k) => full[k]));
        }
        for (const [key, entity] of entities(db))
          if (
            !beforeLoad.has(key) ||
            (entity.table === "resumes" &&
              !metadataOnly &&
              result.rows.some((r) => recordKey(table, r) === key))
          )
            original.set(key, entity);
        current.loaded.add(scope);
      }
      async function prepare(sql: string, values: unknown[]) {
        const tables = [...sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi)]
          .map((m) => m[1])
          .filter((t) => databaseTables.includes(t));
        for (const table of new Set(tables)) {
          let collection: string | undefined, id: string | undefined;
          if (table === "records") {
            const match = /collection\s*=\s*\$(\d+)/i.exec(sql);
            collection = match
              ? String(values[Number(match[1]) - 1])
              : undefined;
            if (/^INSERT INTO records\(/i.test(sql.trim()))
              collection = String(values[0]);
            const key = /\bid\s*=\s*\$(\d+)/i.exec(sql);
            id = key ? String(values[Number(key[1]) - 1]) : undefined;
            // Load one collection before its first write, rather than one network
            // round trip per record in a batched import or attendance analysis.
            if (/^INSERT INTO records\(/i.test(sql.trim())) id = undefined;
            if (!collection && /LIMIT 1\b/.test(sql)) collection = "workspace";
          }
          if (table === "resumes") {
            const key = /\bid\s*=\s*\$(\d+)/i.exec(sql);
            if (key) id = String(values[Number(key[1]) - 1]);
          }
          await load(
            table,
            collection,
            id,
            table === "resumes" &&
              !/SELECT\s+(?:\*|.*(?:content|extracted_text))/i.test(sql),
          );
          if (table === "records" && collection === "workspace") {
            const stored = db
              .prepare(
                "SELECT payload FROM records WHERE collection='workspace' AND id='main'",
              )
              .get() as DatabaseRow | undefined;
            if (stored) {
              const s = JSON.parse(String(stored.payload));
              if (s.persistenceProjection) {
                const pending = workspaceHydrationTables.filter(
                  (table) =>
                    !current.loaded.has(
                      JSON.stringify([table, "", "", table === "resumes"]),
                    ),
                );
                if (pending.length) {
                  const batch = await gatewayRequest<{
                    revision: number;
                    results: DatabaseRow[][];
                  }>("loadMany", {
                    queries: pending.map((table) => ({
                      table,
                      tab: tabFor(table),
                      metadataOnly: table === "resumes",
                    })),
                  });
                  for (let i = 0; i < pending.length; i++)
                    await load(
                      pending[i],
                      undefined,
                      undefined,
                      pending[i] === "resumes",
                      {
                        revision: batch.revision,
                        rows: batch.results[i],
                      },
                    );
                }
                for (const [key, source] of Object.entries(stateKeys)) {
                  await load(source);
                  s[key] = (
                    db
                      .prepare(`SELECT payload FROM ${source}`)
                      .all() as DatabaseRow[]
                  ).map((r) => JSON.parse(String(r.payload)));
                }
                delete s.persistenceProjection;
                db.prepare(
                  "UPDATE records SET payload=? WHERE collection='workspace' AND id='main'",
                ).run(JSON.stringify(s));
              }
            }
          }
        }
      }
      // Hydration may precede a local transaction, but writes are never published
      // until an atomic revision-checked remote commit succeeds.
      db.exec("BEGIN");
      try {
        const result = await fn({
          query: async (sql, values = []) => {
            const writing = !/^\s*SELECT/i.test(sql);
            if (readOnly && writing)
              throw new SafeError("This operation is read-only.", 403);
            await prepare(sql, values);
            baseline = true;
            const order: number[] = [];
            const stmt = db.prepare(
              sql.replace(/\$(\d+)/g, (_, n) => {
                order.push(Number(n) - 1);
                return "?";
              }),
            );
            const args = order.map(
              (i) => (values[i] ?? null) as string | number | null,
            );
            return writing
              ? (stmt.run(...args), [])
              : (stmt.all(...args) as Record<string, unknown>[]);
          },
        });
        if (!readOnly && baseline) {
          const after = entities(db),
            changes: Record<string, unknown>[] = [];
          for (const [key, e] of after)
            if (
              JSON.stringify(original.get(key)?.row) !== JSON.stringify(e.row)
            )
              changes.push({
                ...e,
                cells: e.private ? undefined : sheetCells(e),
              });
          for (const [key, e] of original)
            if (!after.has(key))
              changes.push({ ...e, deleted: true, cells: [] });
          if (changes.length) {
            const commitId = crypto.randomUUID();
            let committed: { revision: number };
            try {
              committed = await gatewayRequest("commit", {
                expectedRevision: current.revision,
                commitId,
                changes,
              });
            } catch (error) {
              globalSheets.djcSheetsCache = undefined;
              throw error;
            }
            current.revision = committed.revision;
            current.checkedAt = Date.now();
          }
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        current.loaded.clear();
        globalSheets.djcSheetsCache = undefined;
        db.close();
        throw error;
      }
    },
  );
  globalSheets.djcSheetsQueue = run.catch(() => undefined);
  return run;
}
