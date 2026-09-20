import "server-only";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  databaseTables,
  recordKey,
  sheetCells,
  entitySheets,
  collectionSheets,
  type DatabaseRow,
} from "@/lib/sheets-schema";
import {
  exportDatabase,
  migrationProjection,
  snapshotHash,
  sheetsConfiguration,
  type DatabaseExport,
  type MigrationReport,
} from "./sheets-management";
import {
  gatewayRequest,
  gatewayConfigured,
  sheetsPrimary,
} from "./sheets-gateway";
import { seal, unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import {
  readTransaction,
  transaction,
  putRecord,
  readRecord,
} from "./database";
import { audit } from "./repository";
import type { User } from "@/types";
import { persistenceMaintenance } from "./persistence-maintenance";
export function validateExport(data: DatabaseExport) {
  const issues: { table: string; key: string; reason: string }[] = [];
  if (data.version !== 1 || !data.tables)
    throw new SafeError("Unsupported database backup format.");
  const keys = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const table of databaseTables) {
    if (!Array.isArray(data.tables[table]))
      throw new SafeError(`Backup is missing ${table}.`);
    const seen = new Set<string>();
    keys.set(
      table,
      new Set(data.tables[table].map((r) => String(r.id ?? r.application_id))),
    );
    for (const row of data.tables[table]) {
      const key = recordKey(table, row);
      if (seen.has(key)) {
        duplicates++;
        issues.push({ table, key, reason: "Duplicate stable key" });
      }
      seen.add(key);
      if (row.payload) {
        try {
          JSON.parse(String(row.payload));
        } catch {
          issues.push({
            table,
            key,
            reason: "Record JSON could not be decoded",
          });
        }
      }
    }
  }
  for (const row of data.tables.applications) {
    for (const [field, target] of [
      ["applicant_id", "applicants"],
      ["hiring_need_id", "hiring_needs"],
      ["resume_id", "resumes"],
    ])
      if (row[field] && !keys.get(target)?.has(String(row[field])))
        issues.push({
          table: "applications",
          key: String(row.id),
          reason: `Missing ${target} relationship`,
        });
  }
  for (const table of [
    "interviews",
    "application_requirements",
    "screening_results",
    "employment_records",
    "application_events",
    "intake_window",
  ])
    for (const row of data.tables[table])
      if (!keys.get("applications")?.has(String(row.application_id)))
        issues.push({
          table,
          key: recordKey(table, row),
          reason: "Missing application relationship",
        });
  return {
    issues,
    duplicates,
    records: Object.values(data.tables).reduce((n, rows) => n + rows.length, 0),
  };
}
export async function saveSourceBackup(data: DatabaseExport) {
  const id = crypto.randomUUID(),
    root = path.join(
      process.env.VERCEL ? "/tmp" : process.cwd(),
      ".data",
      "migrations",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${id}.enc`);
  await writeFile(file, seal(data, config().encryptionKey), { mode: 0o600 });
  const restored = unseal<DatabaseExport>(
    await readFile(file, "utf8"),
    config().encryptionKey,
  );
  if (snapshotHash(restored) !== snapshotHash(data))
    throw new SafeError(
      "The source backup did not pass verification. Migration stopped.",
      503,
    );
  return { id, file, hash: snapshotHash(data) };
}
export async function migrateToGateway(user: User) {
  return persistenceMaintenance.run(true, async () => {
    await transaction(async (tx) => {
      const lock = await readRecord<{ frozen?: boolean; expiresAt?: number }>(
        tx,
        "persistence_control",
        "source",
      );
      if (lock?.frozen || (lock?.expiresAt || 0) > Date.now())
        throw new SafeError(
          "Another migration is active or already verified. Review Migration Status first.",
          409,
        );
      await putRecord(tx, "persistence_control", "source", {
        expiresAt: Date.now() + 600000,
        frozen: false,
      });
    });
    let verified = false;
    try {
      const report = await performMigration(user);
      verified = report.verified;
      return report;
    } finally {
      await transaction((tx) =>
        putRecord(tx, "persistence_control", "source", {
          expiresAt: 0,
          frozen: verified,
        }),
      );
    }
  });
}
async function performMigration(user: User) {
  if (sheetsPrimary())
    throw new SafeError(
      "Sheets is already primary. Use validation or a reviewed restore instead.",
      409,
    );
  if (!gatewayConfigured())
    throw new SafeError(
      "Finish the authenticated Sheets gateway setup before migration. Neon will remain unchanged.",
      409,
    );
  const c = await sheetsConfiguration();
  if (!c || c.schema !== "Valid")
    throw new SafeError("Connect and validate the workbook first.", 409);
  // The source is read under one repeatable snapshot. Its independently encrypted
  // backup survives any copy/verification failure. Never mutate or drop Neon.
  const data = await exportDatabase(),
    checked = validateExport(data),
    backup = await saveSourceBackup(data);
  const report: MigrationReport = {
    id: backup.id,
    startedAt: new Date().toISOString(),
    read: checked.records,
    migrated: 0,
    skipped: 0,
    review: checked.issues.length,
    duplicates: checked.duplicates,
    errors: checked.issues.map((i) => `${i.table}: ${i.reason} (${i.key})`),
    counts: {},
    verified: false,
    sourceHash: backup.hash,
    status: "Preparing verified migration",
  };
  await transaction((tx) =>
    putRecord(tx, "migration_reports", report.id, report),
  );
  if (checked.issues.length) {
    await transaction((tx) =>
      putRecord(tx, "migration_issues", report.id, checked.issues),
    );
    return report;
  }
  const projection = migrationProjection(data),
    all = [...projection.entities, ...projection.privateRows];
  let status = await gatewayRequest<{
    revision: number;
    verified: boolean;
    spreadsheetId: string;
  }>("status");
  if (status.spreadsheetId !== c.id)
    throw new SafeError(
      "The gateway targets a different workbook. Verify Data Management configuration.",
      409,
    );
  if (status.verified)
    throw new SafeError(
      "The destination already contains a verified database. A restore preview and explicit confirmation are required.",
      409,
    );
  try {
    let group: typeof all = [],
      bytes = 0;
    const flush = async () => {
      if (!group.length) return;
      status = {
        ...status,
        ...(await gatewayRequest<{ revision: number }>("commit", {
          migration: true,
          expectedRevision: status.revision,
          commitId: crypto.randomUUID(),
          changes: group.map((e) => ({
            ...e,
            cells: e.private ? undefined : sheetCells(e),
          })),
        })),
      };
      report.migrated += group.length;
      group = [];
      bytes = 0;
    };
    for (const e of all) {
      const size = JSON.stringify(e).length;
      if (group.length && (bytes + size > 1200000 || group.length >= 100))
        await flush();
      group.push(e);
      bytes += size;
    }
    await flush();
    // Read back every stable key and every field, including encrypted document
    // bytes, Gmail IDs, timestamps, audit and email records. Count alone is not proof.
    for (const table of databaseTables) {
      const expected = all.filter((e) => e.table === table);
      const collections =
        table === "records"
          ? [...new Set(expected.map((e) => String(e.row.collection)))]
          : [undefined];
      const rows: DatabaseRow[] = [];
      for (const collection of collections) {
        const target = await gatewayRequest<{
          revision: number;
          rows: DatabaseRow[];
        }>("load", {
          table,
          collection,
          tab:
            table === "records"
              ? collectionSheets[collection!] || "Settings and Configuration"
              : entitySheets[table],
        });
        if (target.revision !== status.revision)
          throw new SafeError(
            "The migration destination changed during verification.",
            409,
          );
        rows.push(...target.rows);
      }
      const found = new Map(rows.map((r) => [recordKey(table, r), r]));
      let matches = 0;
      const canonical = (r: DatabaseRow) =>
        JSON.stringify(Object.entries(r).sort());
      for (const e of expected)
        if (
          found.has(e.key) &&
          canonical(found.get(e.key)!) === canonical(e.row)
        )
          matches++;
        else report.errors.push(`Verification failed: ${table} ${e.key}`);
      report.counts[table] = { source: expected.length, target: matches };
      if (found.size !== expected.length)
        report.errors.push(`${table}: unexpected destination record count`);
    }
    const current = await exportDatabase();
    // Migration report bookkeeping itself is excluded from the source fence.
    const withoutReports = (v: DatabaseExport) => ({
      ...v,
      tables: {
        ...v.tables,
        records: v.tables.records.filter(
          (r) =>
            !["migration_reports", "migration_issues"].includes(
              String(r.collection),
            ),
        ),
      },
    });
    if (
      snapshotHash(withoutReports(current)) !==
      snapshotHash(withoutReports(data))
    )
      report.errors.push(
        "Source records changed during migration. Run migration again with intake and user writes paused before cutover.",
      );
    report.verified = report.errors.length === 0;
    report.status = report.verified
      ? "Verified — ready for administrator cutover"
      : "Needs review — source preserved";
    report.completedAt = new Date().toISOString();
    if (report.verified) {
      // Verification bookkeeping must itself survive cutover. Write it locally,
      // then include the resulting records and audit event in the same atomic
      // gateway commit that publishes the verified marker.
      await transaction(async (tx) => {
        await putRecord(tx, "migration_reports", report.id, report);
        await putRecord(tx, "sheets_configuration", "primary", {
          ...c,
          migration: report,
        });
        await audit(tx, user.email, "sheets.migration_verified", undefined, {
          reportId: report.id,
          verified: true,
          read: report.read,
          migrated: report.migrated,
          errors: 0,
        });
      });
      const final = migrationProjection(await exportDatabase());
      const baseline = new Map(all.map((e) => [e.key, JSON.stringify(e.row)]));
      const changes = [...final.entities, ...final.privateRows].filter(
        (e) => baseline.get(e.key) !== JSON.stringify(e.row),
      );
      await gatewayRequest("commit", {
        migration: true,
        expectedRevision: status.revision,
        commitId: crypto.randomUUID(),
        changes: changes.map((e) => ({
          ...e,
          cells: e.private ? undefined : sheetCells(e),
        })),
        verification: report,
      });
      return report;
    }
  } catch (error) {
    report.verified = false;
    report.errors.push(
      error instanceof SafeError
        ? error.message
        : "Migration interrupted. Original data and encrypted backup are preserved.",
    );
    report.status = "Needs attention";
  }
  await transaction(async (tx) => {
    await putRecord(tx, "migration_reports", report.id, report);
    await putRecord(tx, "sheets_configuration", "primary", {
      ...c,
      migration: report,
    });
    await audit(tx, user.email, "sheets.migration_verified", undefined, {
      reportId: report.id,
      verified: report.verified,
      read: report.read,
      migrated: report.migrated,
      errors: report.errors.length,
    });
  });
  return report;
}
export async function migrationStatus() {
  return readTransaction(
    async (tx) =>
      (
        await tx.query("SELECT payload FROM records WHERE collection=$1", [
          "migration_reports",
        ])
      )
        .map((r) => JSON.parse(String(r.payload)) as MigrationReport)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null,
  );
}
