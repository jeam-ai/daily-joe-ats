import "server-only";
import { createHash } from "node:crypto";
import {
  requiredSheets,
  persistenceColumns,
  sheetEntity,
  sheetCells,
  databaseTables,
  positionSheetName,
  positionViewFormula,
  type DatabaseRow,
} from "@/lib/sheets-schema";
import {
  readTransaction,
  transaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { withStore } from "./store";
import { accessToken } from "@/lib/google/gmail/service";
import { SafeError, config } from "./config";
import { audit } from "./repository";
import type { User } from "@/types";
export type SheetsConfiguration = {
  id: string;
  name: string;
  account: string;
  createdAt: string;
  lastSuccess?: string;
  lastFailure?: string;
  error?: string;
  schema?: "Valid" | "Needs repair";
  pending?: number;
  failed?: number;
  migration?: MigrationReport;
  viewPositions?: string;
};
export type MigrationReport = {
  id: string;
  startedAt: string;
  completedAt?: string;
  read: number;
  migrated: number;
  skipped: number;
  review: number;
  duplicates: number;
  errors: string[];
  counts: Record<string, { source: number; target: number }>;
  verified: boolean;
  sourceHash: string;
  status: string;
};
export type DatabaseExport = {
  version: 1;
  exportedAt: string;
  tables: Record<string, DatabaseRow[]>;
};
export const sheetsConfiguration = () =>
  readTransaction((tx) =>
    readRecord<SheetsConfiguration>(tx, "sheets_configuration", "primary"),
  );
async function authorization() {
  const c = await withStore((s) => s.sheetsConnection, false);
  if (!c)
    throw new SafeError(
      "Connect Google Sheets using the careers account first.",
      409,
    );
  if (c.email.toLowerCase() !== config().officialEmail)
    throw new SafeError(
      "Reconnect Google Sheets using the official careers account.",
      403,
    );
  return { token: await accessToken(c), account: c.email };
}
export async function sheetsRequest<T>(path: string, init: RequestInit = {}) {
  const { token } = await authorization();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!r.ok)
    throw new SafeError(
      r.status === 429
        ? "Google Sheets is rate limited. Wait briefly and retry."
        : r.status === 401 || r.status === 403
          ? "Google Sheets access could not be verified. Reconnect the official account and verify spreadsheet access."
          : "Google Sheets could not complete this operation. Retry and check System Health.",
      r.status === 429 ? 429 : 502,
    );
  return r.json() as Promise<T>;
}
export async function exportDatabase(
  tx?: Transaction,
): Promise<DatabaseExport> {
  const read = async (tx: Transaction) => {
    const tables: Record<string, DatabaseRow[]> = {};
    for (const table of databaseTables)
      tables[table] = (await tx.query(
        `SELECT * FROM ${table}`,
      )) as DatabaseRow[];
    return {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      tables,
    };
  };
  return tx ? read(tx) : readTransaction(read);
}
export function snapshotHash(data: DatabaseExport) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        databaseTables.map((t) => [
          t,
          (data.tables[t] || [])
            .map((r) => JSON.stringify(Object.entries(r).sort()))
            .sort(),
        ]),
      ),
    )
    .digest("hex");
}
export function migrationProjection(data: DatabaseExport) {
  // Legacy workspace/tracker copies are read models. The normalized entities
  // own recruitment records; a configuration row stores only workspace settings.
  const demoIds = new Set<string>(),
    demoApplicants = new Set<string>(),
    demoResumes = new Set<string>();
  for (const row of data.tables.applications || []) {
    const a = JSON.parse(String(row.payload));
    if (a.isDemo || a.source === "Demo") {
      demoIds.add(String(row.id));
      demoApplicants.add(String(row.applicant_id));
      if (row.resume_id) demoResumes.add(String(row.resume_id));
    }
  }
  const entities = [];
  const privateRows = [];
  for (const table of databaseTables)
    for (const original of data.tables[table] || []) {
      const row = { ...original };
      if (table === "records" && row.collection === "workspace") {
        const s = JSON.parse(String(row.payload));
        for (const key of [
          "applications",
          "hiringNeeds",
          "qualifications",
          "emailTemplates",
          "requirementTemplates",
          "locations",
          "notifications",
          "users",
        ])
          delete s[key];
        row.payload = JSON.stringify({ ...s, persistenceProjection: 1 });
      }
      const entity = sheetEntity(table, row);
      if (
        demoIds.has(String(row.application_id)) ||
        demoIds.has(String(row.id)) ||
        demoApplicants.has(String(row.id)) ||
        demoResumes.has(String(row.id))
      )
        entity.private = true;
      if (
        table === "records" &&
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
        ].includes(String(row.collection))
      )
        entity.private = true;
      // Store encrypted documents, sessions, pending email bodies and large binary
      // artifacts in private Drive storage via the gateway, never workbook cells.
      if (entity.private) privateRows.push(entity);
      else entities.push(entity);
    }
  return { entities, privateRows };
}
async function saveConfiguration(
  value: SheetsConfiguration,
  user: User,
  action: string,
) {
  await transaction(async (tx) => {
    await putRecord(tx, "sheets_configuration", "primary", value);
    await audit(tx, user.email, action, undefined, {
      name: value.name,
      schema: value.schema,
    });
  });
}
export async function connectWorkbook(
  user: User,
  input: { id?: string; create?: boolean },
) {
  const auth = await authorization();
  const current = await sheetsConfiguration();
  if (input.create && current)
    throw new SafeError(
      "A workbook is already connected. Export and review it before choosing a replacement.",
      409,
    );
  if (!input.create && !/^[A-Za-z0-9_-]{20,160}$/.test(input.id || ""))
    throw new SafeError("Enter a valid Google spreadsheet ID.");
  const result = await sheetsRequest<{
    spreadsheetId: string;
    properties: { title: string };
  }>(
    input.create ? "" : `/${input.id}?fields=spreadsheetId,properties.title`,
    input.create
      ? {
          method: "POST",
          body: JSON.stringify({
            properties: { title: "Daily Joe Careers — Operational Database" },
            sheets: requiredSheets.map((title) => ({
              properties: {
                title,
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: 1000,
                  columnCount: 17,
                },
              },
            })),
          }),
        }
      : {},
  );
  const value: SheetsConfiguration = {
    id: result.spreadsheetId,
    name: result.properties.title,
    account: auth.account,
    createdAt: new Date().toISOString(),
    schema: "Needs repair",
  };
  await saveConfiguration(value, user, "sheets.connected");
  return validateWorkbook(user, true);
}
export async function validateWorkbook(user: User, repair = false) {
  const c = await sheetsConfiguration();
  if (!c) throw new SafeError("Connect or create a spreadsheet first.", 409);
  const meta = await sheetsRequest<{
    sheets: { properties: { sheetId: number; title: string } }[];
  }>(`/${c.id}?fields=sheets.properties`);
  const names = new Set(meta.sheets.map((s) => s.properties.title)),
    missing = requiredSheets.filter((n) => !names.has(n));
  if (repair) {
    if (missing.length)
      await sheetsRequest(`/${c.id}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: missing.map((title) => ({
            addSheet: {
              properties: {
                title,
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: 1000,
                  columnCount: 17,
                },
              },
            },
          })),
        }),
      });
    const control = meta.sheets.find(
      (s) => s.properties.title === "Sync Status and System Health",
    );
    if (control)
      await sheetsRequest(`/${c.id}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: control.properties.sheetId,
                  gridProperties: { columnCount: 22 },
                },
                fields: "gridProperties.columnCount",
              },
            },
          ],
        }),
      });
    const ranges = requiredSheets
      .filter((t) => t !== "Schema Guide")
      .map((t) => ({ range: `'${t}'!A1:Q1`, values: [persistenceColumns] }));
    // Header repairs never clear data rows. Existing conflicting headers require
    // an import preview instead of silently reinterpreting their columns.
    const existing = await sheetsRequest<{
      valueRanges: { range: string; values?: string[][] }[];
    }>(
      `/${c.id}/values:batchGet?${ranges.map((r) => `ranges=${encodeURIComponent(r.range)}`).join("&")}`,
    );
    for (const item of existing.valueRanges)
      if (
        item.values?.[0]?.length &&
        item.values[0].join("|") !== persistenceColumns.join("|")
      )
        throw new SafeError(
          "This workbook contains a different schema. Import preview is required; its records have not been overwritten.",
          409,
        );
    await sheetsRequest(`/${c.id}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: [
          ...ranges,
          {
            range: "'Schema Guide'!A1:D40",
            values: [
              ["Sheet", "Purpose", "Key", "Authority"],
              ...requiredSheets
                .filter((t) => t !== "Schema Guide")
                .map((t) => [
                  t,
                  t === "Demo Data"
                    ? "Demo records are isolated in private storage; no production demo rows."
                    : t.includes("Applications") && t !== "Applications"
                      ? "Position view derived from Applications"
                      : "Operational records with stable IDs; JSON chunks preserve all original values.",
                  "Record Key + Part",
                  t.includes("Applications") && t !== "Applications"
                    ? "Derived view"
                    : "Canonical entity or named read model",
                ]),
            ],
          },
        ],
      }),
    });
  }
  const headerTabs = requiredSheets.filter(
    (t) => t !== "Schema Guide" && (repair || names.has(t)),
  );
  const headers = await sheetsRequest<{
    valueRanges: { range: string; values?: string[][] }[];
  }>(
    `/${c.id}/values:batchGet?${headerTabs.map((t) => `ranges=${encodeURIComponent(`'${t}'!A1:Q1`)}`).join("&")}`,
  );
  const mismatched = headers.valueRanges
    .filter((r) => r.values?.[0]?.join("|") !== persistenceColumns.join("|"))
    .map((r) => r.range);
  c.schema =
    (missing.length && !repair) || mismatched.length ? "Needs repair" : "Valid";
  c.lastSuccess = new Date().toISOString();
  delete c.error;
  await saveConfiguration(
    c,
    user,
    repair ? "sheets.structure_repaired" : "sheets.validated",
  );
  if (repair && c.schema === "Valid") {
    const positions = await readTransaction((tx) =>
      tx.query("SELECT * FROM qualification_templates"),
    );
    await refreshWorkbookViews(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        tables: { qualification_templates: positions as DatabaseRow[] },
      },
      true,
    );
  }
  return { ...c, missing: repair ? mismatched : [...missing, ...mismatched] };
}
export async function refreshWorkbookViews(
  data: DatabaseExport,
  force = false,
) {
  const c = await sheetsConfiguration();
  if (!c) throw new SafeError("Connect a workbook first.", 409);
  const positions = [
    ...new Set([
      "Barista",
      "Team Leader",
      "Supervisor",
      ...(data.tables.qualification_templates || [])
        .map((r) => String(JSON.parse(String(r.payload)).position))
        .filter(Boolean),
    ]),
  ];
  const signature = JSON.stringify(positions);
  if (!force && c.viewPositions === signature) return;
  const views = positions
    .filter((p) => p.toLowerCase() !== "other")
    .map((p) => ({
      title: positionSheetName(p),
      formula: positionViewFormula(p),
    }));
  views.push(
    {
      title: "Other Applications",
      formula: `=IFERROR(FILTER('Applications'!A2:Q,'Applications'!A2:A<>"",'Applications'!H2:H=1,('Applications'!N2:N="Other")+(COUNTIF('Positions'!N2:N,'Applications'!N2:N)=0)),"")`,
    },
    {
      title: "Positions",
      formula: `=IFERROR(FILTER('Qualifications'!A2:Q,'Qualifications'!A2:A<>"",'Qualifications'!H2:H=1),"")`,
    },
    {
      title: "Onboarding",
      formula: `=IFERROR(FILTER('Applications'!A2:Q,'Applications'!P2:P="Onboarding",'Applications'!H2:H=1),"")`,
    },
  );
  const meta = await sheetsRequest<{
    sheets: { properties: { title: string } }[];
  }>(`/${c.id}?fields=sheets.properties.title`);
  const missing = views.filter(
    (v) => !meta.sheets.some((s) => s.properties.title === v.title),
  );
  if (missing.length)
    await sheetsRequest(`/${c.id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: missing.map((v) => ({
          addSheet: {
            properties: {
              title: v.title,
              gridProperties: {
                rowCount: 2000,
                columnCount: 17,
                frozenRowCount: 1,
              },
            },
          },
        })),
      }),
    });
  // Only managed derived tabs receive formulas. Their cells are never imported as authoritative records.
  await sheetsRequest(`/${c.id}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: views.flatMap((v) => [
        {
          range: `'${v.title.replace(/'/g, "''")}'!A1:Q1`,
          values: [persistenceColumns],
        },
        { range: `'${v.title.replace(/'/g, "''")}'!A2`, values: [[v.formula]] },
      ]),
    }),
  });
  await transaction((tx) =>
    putRecord(tx, "sheets_configuration", "primary", {
      ...c,
      viewPositions: signature,
    }),
  );
}
export async function upsertWorkbook(data: DatabaseExport, user: User) {
  const c = await sheetsConfiguration();
  if (!c) throw new SafeError("Create or connect a workbook first.", 409);
  const validated = await validateWorkbook(user);
  if (validated.schema !== "Valid")
    throw new SafeError(
      "Repair the spreadsheet structure before migration.",
      409,
    );
  const projected = migrationProjection(data),
    byTab = new Map<string, typeof projected.entities>();
  for (const e of projected.entities)
    byTab.set(e.tab, [...(byTab.get(e.tab) || []), e]);
  const report: MigrationReport = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    read: Object.values(data.tables).reduce((n, r) => n + r.length, 0),
    migrated: 0,
    skipped: 0,
    review: projected.privateRows.length,
    duplicates: 0,
    errors: [],
    counts: {},
    verified: false,
    sourceHash: snapshotHash(data),
    status: "Copying operational records",
  };
  try {
    for (const [tab, entities] of byTab) {
      const old = await sheetsRequest<{ values?: unknown[][] }>(
          `/${c.id}/values/${encodeURIComponent(`'${tab}'!A2:Q`)}`,
        ),
        rows = old.values || [],
        index = new Map<string, number>();
      rows.forEach((r, i) => {
        if (r[0]) {
          const key = `${r[0]}:${r[7]}`;
          if (index.has(key)) report.duplicates++;
          index.set(key, i + 2);
        }
      });
      if (report.duplicates)
        throw new SafeError(
          "Duplicate spreadsheet keys need review. Existing records were preserved.",
          409,
        );
      let next = rows.length + 2;
      const updates: { range: string; values: unknown[][] }[] = [];
      for (const entity of entities) {
        const parts = sheetCells(entity);
        for (const cells of parts) {
          const row = index.get(`${entity.key}:${cells[7]}`) || next++;
          updates.push({ range: `'${tab}'!A${row}:Q${row}`, values: [cells] });
        }
        rows.forEach((r, i) => {
          if (r[0] === entity.key && Number(r[7]) > parts.length)
            updates.push({
              range: `'${tab}'!A${i + 2}:Q${i + 2}`,
              values: [Array(17).fill("")],
            });
        });
      }
      // Expand only as necessary. Values use RAW, preventing formula injection.
      const metadata = await sheetsRequest<{
        sheets: {
          properties: {
            sheetId: number;
            title: string;
            gridProperties: { rowCount: number };
          };
        }[];
      }>(`/${c.id}?fields=sheets.properties`);
      const sheet = metadata.sheets.find(
        (s) => s.properties.title === tab,
      )!.properties;
      if (next > sheet.gridProperties.rowCount)
        await sheetsRequest(`/${c.id}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({
            requests: [
              {
                appendDimension: {
                  sheetId: sheet.sheetId,
                  dimension: "ROWS",
                  length: next - sheet.gridProperties.rowCount + 100,
                },
              },
            ],
          }),
        });
      for (let n = 0; n < updates.length; n += 100)
        await sheetsRequest(`/${c.id}/values:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({
            valueInputOption: "RAW",
            data: updates.slice(n, n + 100),
          }),
        });
      const check = await sheetsRequest<{ values?: unknown[][] }>(
          `/${c.id}/values/${encodeURIComponent(`'${tab}'!A2:Q`)}`,
        ),
        verified = new Map(
          (check.values || [])
            .filter((r) => r[0])
            .map((r) => [`${r[0]}:${r[7]}`, r]),
        );
      let matched = 0;
      for (const entity of entities) {
        const cells = sheetCells(entity);
        if (
          cells.every(
            (r) => verified.get(`${entity.key}:${r[7]}`)?.[9] === r[9],
          )
        )
          matched++;
        else
          report.errors.push(
            `Verification failed for ${entity.table} record ${entity.row.id || entity.row.application_id}`,
          );
      }
      report.counts[tab] = { source: entities.length, target: matched };
      report.migrated += matched;
    }
    await refreshWorkbookViews(data);
    report.status = report.review
      ? "Operational copy verified; private storage and cutover verification required"
      : "Awaiting cutover verification";
    report.verified = report.errors.length === 0 && report.review === 0;
    report.completedAt = new Date().toISOString();
    c.lastSuccess = report.completedAt;
    c.pending = 0;
    c.failed = report.errors.length;
  } catch (error) {
    report.errors.push(
      error instanceof SafeError
        ? error.message
        : "Migration could not finish. Original records are preserved.",
    );
    report.status = "Needs attention";
    c.lastFailure = new Date().toISOString();
    c.error = report.errors.at(-1);
    c.failed = 1;
  }
  c.migration = report;
  c.viewPositions = (await sheetsConfiguration())?.viewPositions;
  await saveConfiguration(c, user, "sheets.migration_checked");
  return report;
}
