import "server-only";
import { z } from "zod";
import {
  sheetsConfiguration,
  sheetsRequest,
  exportDatabase,
  snapshotHash,
  type DatabaseExport,
} from "./sheets-management";
import {
  entitySheets,
  collectionSheets,
  databaseTables,
  recordKey,
  type DatabaseRow,
} from "@/lib/sheets-schema";
import { validateExport, saveSourceBackup } from "./sheets-migration";
import {
  transaction,
  readTransaction,
  putRecord,
  readRecord,
} from "./database";
import { getState, saveState, audit } from "./repository";
import { applicationSchema, stateSchema, userSchema } from "@/lib/domain";
import { seal, unseal } from "@/lib/auth/security";
import { SafeError, config } from "./config";
import type { User, AppState } from "@/types";
import { INTAKE_QUEUE_LIMIT } from "@/lib/data-policy";
type Preview = {
  id: string;
  actor: string;
  expiresAt: number;
  sourceHash: string;
  rows: { table: string; row: DatabaseRow }[];
  created: number;
  updated: number;
  unchanged: number;
  issues: string[];
  used?: boolean;
};
const canonical = (r: DatabaseRow) => JSON.stringify(Object.entries(r).sort());
export async function previewSpreadsheetImport(user: User) {
  const c = await sheetsConfiguration();
  if (!c) throw new SafeError("Connect a spreadsheet first.");
  const source = await exportDatabase(),
    rows: Preview["rows"] = [],
    issues: string[] = [],
    seen = new Set<string>();
  const tabs = [
    ...new Set([
      ...Object.values(entitySheets),
      ...Object.values(collectionSheets),
      "Settings and Configuration",
    ]),
  ];
  const fetched = await sheetsRequest<{
    valueRanges: { range: string; values?: unknown[][] }[];
  }>(
    `/${c.id}/values:batchGet?${tabs.map((t) => `ranges=${encodeURIComponent(`'${t}'!A2:Q`)}`).join("&")}`,
  );
  for (const range of fetched.valueRanges) {
    const parts = new Map<string, unknown[][]>();
    for (const row of range.values || []) {
      if (row[0])
        parts.set(String(row[0]), [...(parts.get(String(row[0])) || []), row]);
    }
    for (const [key, values] of parts) {
      try {
        values.sort((a, b) => Number(a[7]) - Number(b[7]));
        if (
          values.length !== Number(values[0][8]) ||
          values.some((r, i) => Number(r[7]) !== i + 1)
        )
          throw Error("incomplete JSON parts");
        const table = String(values[0][1]);
        if (!databaseTables.includes(table)) throw Error("unsupported entity");
        if (["resumes", "users"].includes(table)) continue;
        const row = JSON.parse(
          values.map((r) => String(r[9] || "")).join(""),
        ) as DatabaseRow;
        if (recordKey(table, row) !== key || seen.has(key))
          throw Error("duplicate or invalid stable ID");
        seen.add(key);
        // Integration credentials, jobs, AI prompts, sequence allocation and access
        // controls cannot be injected by spreadsheet import.
        if (table === "records") {
          if (row.collection !== "workspace") continue;
          const p = JSON.parse(String(row.payload));
          if (!p.persistenceProjection)
            throw Error("workspace must be a configuration projection");
          continue;
        }
        if (table === "applications")
          applicationSchema.parse(JSON.parse(String(row.payload)));
        if (table === "audit_logs" || table === "application_events") {
          const old = source.tables[table].find(
            (v) => recordKey(table, v) === key,
          );
          if (old && canonical(old) !== canonical(row))
            throw Error("append-only history cannot be overwritten");
        }
        rows.push({ table, row });
      } catch (e) {
        issues.push(
          `${range.range}: ${key} requires review (${e instanceof z.ZodError ? "record validation failed" : (e as Error).message}).`,
        );
      }
    }
  }
  const merged: DatabaseExport = structuredClone(source);
  let created = 0,
    updated = 0,
    unchanged = 0;
  for (const item of rows) {
    const index = merged.tables[item.table].findIndex(
      (r) => recordKey(item.table, r) === recordKey(item.table, item.row),
    );
    if (index < 0) {
      merged.tables[item.table].push(item.row);
      created++;
    } else if (
      canonical(merged.tables[item.table][index]) !== canonical(item.row)
    ) {
      updated++;
      merged.tables[item.table][index] = item.row;
    } else unchanged++;
  }
  const integrity = validateExport(merged);
  issues.push(...integrity.issues.map((i) => `${i.table}: ${i.reason}`));
  const preview: Preview = {
    id: crypto.randomUUID(),
    actor: user.email,
    expiresAt: Date.now() + 900000,
    sourceHash: snapshotHash({
      ...source,
      tables: {
        ...source.tables,
        records: source.tables.records.filter(
          (r) => r.collection !== "spreadsheet_import_previews",
        ),
      },
    }),
    rows,
    created,
    updated,
    unchanged,
    issues,
  };
  await transaction((tx) =>
    putRecord(
      tx,
      "spreadsheet_import_previews",
      preview.id,
      seal(preview, config().encryptionKey),
    ),
  );
  return {
    id: preview.id,
    created,
    updated,
    unchanged,
    deleted: 0,
    issues,
    expiresAt: preview.expiresAt,
  };
}
export async function confirmSpreadsheetImport(user: User, id: string) {
  const encoded = await readTransaction((tx) =>
    readRecord<string>(tx, "spreadsheet_import_previews", id),
  );
  if (!encoded)
    throw new SafeError("Import preview expired. Preview again.", 409);
  const p = unseal<Preview>(encoded, config().encryptionKey);
  if (
    p.used ||
    p.actor !== user.email ||
    p.expiresAt < Date.now() ||
    p.issues.length
  )
    throw new SafeError(
      "Resolve the preview issues and generate a fresh import preview.",
      409,
    );
  const current = await exportDatabase();
  const clean = (s: DatabaseExport) => ({
    ...s,
    tables: {
      ...s.tables,
      records: s.tables.records.filter(
        (r) => r.collection !== "spreadsheet_import_previews",
      ),
    },
  });
  if (snapshotHash(clean(current)) !== p.sourceHash)
    throw new SafeError(
      "Source records changed after the preview. Preview again before importing.",
      409,
    );
  await saveSourceBackup(current);
  return transaction(async (tx) => {
    const latest = await exportDatabase(tx);
    if (snapshotHash(clean(latest)) !== p.sourceHash)
      throw new SafeError(
        "The workspace changed during backup. Preview again.",
        409,
      );
    for (const { table, row } of p.rows) {
      const schema = await tx.query(`SELECT * FROM ${table} LIMIT 1`);
      const permitted = Object.keys(schema[0] || row);
      const keys = Object.keys(row);
      if (keys.some((k) => !/^[a-z_]+$/.test(k) || !permitted.includes(k)))
        throw new SafeError("Unexpected import columns.");
      const pk =
        table === "application_requirements"
          ? ["id", "application_id"]
          : ["id" in row ? "id" : "application_id"];
      const assignments = keys
        .filter((k) => !pk.includes(k))
        .map((k) => `${k}=excluded.${k}`)
        .join(",");
      await tx.query(
        `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT(${pk.join(",")}) DO ${assignments ? "UPDATE SET " + assignments : "NOTHING"}`,
        keys.map((k) => row[k]),
      );
    }
    const state = await getState(tx);
    const map: Record<string, string> = {
      applications: "applications",
      hiringNeeds: "hiring_needs",
      qualifications: "qualification_templates",
      requirementTemplates: "requirements",
      emailTemplates: "email_templates",
      locations: "locations",
      notifications: "notifications",
    };
    for (const [key, table] of Object.entries(map))
      (state as unknown as Record<string, unknown>)[key] = (
        await tx.query(`SELECT payload FROM ${table}`)
      ).map((r) => JSON.parse(String(r.payload)));
    const parsed = stateSchema.parse(state) as AppState;
    if (
      parsed.applications.filter(
        (a) =>
          !a.isDemo &&
          !a.deletedAt &&
          !["Hired", "Rejected", "Withdrawn", "Talent Pool"].includes(a.status),
      ).length > INTAKE_QUEUE_LIMIT
    )
      throw new SafeError(
        `This import exceeds the ${INTAKE_QUEUE_LIMIT} eligible application capacity.`,
      );
    await saveState(tx, parsed);
    p.used = true;
    await putRecord(
      tx,
      "spreadsheet_import_previews",
      id,
      seal(p, config().encryptionKey),
    );
    await audit(tx, user.email, "sheets.imported", undefined, {
      previewId: id,
      created: p.created,
      updated: p.updated,
    });
    return {
      message:
        "Reviewed spreadsheet records imported. No records were deleted.",
    };
  });
}
