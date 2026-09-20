// Stable SQL entity keys remain the application contract. Workbook tabs are a
// normalized persistence projection; position tabs and nested views are derived.
export const sheetsSchemaVersion = 1;
export const entitySheets: Record<string, string> = {
  applicants: "Applicants",
  applications: "Applications",
  interviews: "Interviews",
  hiring_needs: "Hiring Needs",
  qualification_templates: "Qualifications",
  screening_results: "Qualification Assessments",
  application_requirements: "Requirements",
  employment_records: "Employment Records",
  application_events: "Application Events",
  audit_logs: "Audit History",
  notifications: "Notifications",
  locations: "Locations",
  email_templates: "Email Templates",
  intake_window: "Intake Queue",
  users: "Authorized Users",
  requirements: "Requirement Templates",
  resumes: "Document References",
};
export const collectionSheets: Record<string, string> = {
  email_index: "Email History",
  email_outbox: "Email History",
  email_drafts: "Email History",
  ai_usage: "AI Processing and Usage",
  ai_settings: "AI Processing and Usage",
  ai_runs: "AI Processing and Usage",
  extraction_jobs: "AI Processing and Usage",
  extraction_results: "AI Processing and Usage",
  odoo_uploads: "Timekeeping Uploads",
  odoo_batches: "Timekeeping Analysis",
  odoo_reviews: "Timekeeping Review History",
  odoo_exceptions: "Timekeeping Exceptions",
  odoo_index: "Timekeeping Analysis",
  timekeeping_jobs: "Timekeeping Uploads",
  odoo_mapping: "Odoo Mapping Templates",
  diagnostics: "Sync Status and System Health",
  health: "Sync Status and System Health",
  sync: "Sync Status and System Health",
  jobs: "Sync Status and System Health",
  migration_issues: "Migration Issues",
};
export const privateCollections = [
  "tracker",
  "import_previews",
  "spreadsheet_import_previews",
  "application_sources",
  "timekeeping_inputs",
  "odoo_sources",
  "odoo_uploads",
  "secure",
  "email_drafts",
  "email_outbox",
  "ai_runs",
  "extraction_results",
];
export const derivedSheets = [
  "Barista Applications",
  "Team Leader Applications",
  "Supervisor Applications",
  "Other Applications",
  "Positions",
  "Onboarding",
  "Timekeeping Exceptions",
  "Demo Data",
];
export const requiredSheets = [
  ...new Set([
    ...Object.values(entitySheets),
    ...Object.values(collectionSheets),
    ...derivedSheets,
    "Settings and Configuration",
    "Migration Issues",
    "Schema Guide",
  ]),
];
export const persistenceColumns = [
  "Record Key",
  "Entity",
  "Collection",
  "Stable ID",
  "Name or Reference",
  "Status",
  "Timestamp",
  "Part",
  "Parts",
  "Record JSON",
  "Applicant ID",
  "Applicant Name",
  "Email",
  "Position",
  "Location",
  "Stage",
  "Demo",
];
export type DatabaseRow = Record<string, string | number | null>;
export type PersistedEntity = {
  key: string;
  table: string;
  row: DatabaseRow;
  tab: string;
  private: boolean;
};
export const databaseTables = [
  "records",
  "audit_logs",
  "resumes",
  "users",
  "applicants",
  "hiring_needs",
  "applications",
  "intake_window",
  "interviews",
  "application_requirements",
  "screening_results",
  "employment_records",
  "application_events",
  "qualification_templates",
  "requirements",
  "email_templates",
  "locations",
  "notifications",
];
export function recordKey(table: string, row: DatabaseRow) {
  if (table === "records")
    return JSON.stringify([table, row.collection, row.id]);
  if (table === "application_requirements")
    return JSON.stringify([table, row.application_id, row.id]);
  return JSON.stringify([table, row.id ?? row.application_id]);
}
export function sheetEntity(table: string, row: DatabaseRow): PersistedEntity {
  if (!databaseTables.includes(table))
    throw Error("Unsupported persistence entity");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(String(row.payload || "{}"));
  } catch {
    /* Scalar settings are valid. */
  }
  const privateRecord =
    table === "resumes" ||
    privateCollections.includes(String(row.collection)) ||
    data?.isDemo === true ||
    data?.source === "Demo" ||
    row.state === "Demo";
  return {
    key: recordKey(table, row),
    table,
    row,
    private: privateRecord,
    tab:
      table === "records"
        ? collectionSheets[String(row.collection)] ||
          "Settings and Configuration"
        : entitySheets[table],
  };
}
export function positionSheetName(position: string) {
  const title = position.replace(/[\[\]:*?/\\]/g, " ").trim();
  if (title === position && title.length <= 70) return `${title} Applications`;
  // Preserve distinct custom positions after Google tab-name sanitization.
  let hash = 2166136261;
  for (const character of position)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return `${title.slice(0, 60)}-${(hash >>> 0).toString(36)} Applications`;
}
export function positionViewFormula(position: string) {
  const quoted = position.replace(/"/g, '""');
  return `=IFERROR(FILTER('Applications'!A2:Q,'Applications'!N2:N="${quoted}",'Applications'!H2:H=1),"")`;
}
export function sheetCells(entity: PersistedEntity) {
  if (entity.private)
    throw Error("Private records cannot be written into Sheets");
  const { row } = entity;
  let display: Record<string, unknown> = {};
  try {
    display = JSON.parse(String(row.payload || "{}"));
  } catch {
    /* Scalar values have no display fields. */
  }
  const json = JSON.stringify(row),
    parts = Math.max(1, Math.ceil(json.length / 30000));
  const applicant = display?.applicant as Record<string, unknown> | undefined;
  return Array.from({ length: parts }, (_, part) => [
    entity.key,
    entity.table,
    String(row.collection || ""),
    String(row.id || row.application_id || ""),
    String(
      display?.name ||
        display?.position ||
        display?.title ||
        row.filename ||
        "",
    ),
    String(row.status || row.state || display?.status || ""),
    String(row.occurred_at || display?.appliedAt || display?.createdAt || ""),
    part + 1,
    parts,
    json.slice(part * 30000, (part + 1) * 30000),
    String(row.applicant_id || ""),
    String(applicant?.name || display?.name || ""),
    String(applicant?.email || row.email || ""),
    String(display?.position || ""),
    String(display?.location || ""),
    String(row.stage || ""),
    false,
  ]);
}
