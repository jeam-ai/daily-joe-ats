import "server-only";
import type { AuditEvent } from "@/types/operations";
import type { User } from "@/types";
import { readTransaction, type Transaction } from "./database";
import { SafeError } from "./config";

// Audit metadata is deliberately bounded; documents, prompts and credentials
// never belong in an activity record. Raw provider errors are never passed here.
export function auditDetails(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[details omitted]";
  if (typeof value === "string")
    return value
      .replace(
        /(?:Bearer\s+\S+|AIza[\w-]+|AQ\.[\w-]{20,}|postgres(?:ql)?:\/\/\S+)/gi,
        "[redacted]",
      )
      .slice(0, 1200);
  if (Array.isArray(value))
    return value.slice(0, 40).map((v) => auditDetails(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/secret|password|token|api.?key|authorization|cookie|prompt|resume.?text|extracted.?text|raw.?content|connection.?string/i.test(
              key,
            ),
        )
        .slice(0, 40)
        .map(([k, v]) => [k, auditDetails(v, depth + 1)]),
    );
  return value;
}
export async function writeAudit(
  tx: Transaction,
  actor: string,
  action: string,
  entityId?: string,
  metadata: unknown = {},
) {
  const rows = actor.includes("@")
    ? await tx.query("SELECT role FROM users WHERE email=$1", [
        actor.toLowerCase(),
      ])
    : [];
  const detail = (auditDetails(metadata) || {}) as Record<string, unknown>;
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    actor,
    role: String(
      rows[0]?.role || (actor === "System" ? "System" : "Not recorded"),
    ),
    action,
    module: String(detail.module || action.split(".")[0]),
    entityType: String(
      detail.entityType || (entityId ? "Application" : action.split(".")[0]),
    ),
    entityId:
      entityId ||
      (typeof detail.entityId === "string" ? detail.entityId : undefined),
    source: String(detail.source || (actor === "System" ? "System" : "User")),
    status: String(detail.status || "Completed"),
    details: detail,
  };
  await tx.query(
    "INSERT INTO audit_logs(id,occurred_at,actor,action,application_id,payload) VALUES($1,$2,$3,$4,$5,$6)",
    [
      event.id,
      event.timestamp,
      actor,
      action,
      entityId || null,
      JSON.stringify({ ...detail, _event: event }),
    ],
  );
  return event.id;
}
export async function auditHistory(user: User, params: URLSearchParams) {
  const applicant = params.get("applicant");
  if (user.role === "Viewer" && !applicant)
    throw new SafeError(
      "Open an applicant to see its operational activity.",
      403,
    );
  const values: unknown[] = [];
  const clauses: string[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (applicant) clauses.push(`application_id=${bind(applicant)}`);
  if (user.role !== "Admin")
    clauses.push(
      "(application_id IS NOT NULL OR action LIKE 'timekeeping.%' OR action LIKE 'odoo.%' OR action LIKE 'screening.%')",
    );
  for (const [key, col] of [
    ["user", "actor"],
    ["action", "action"],
  ])
    if (params.get(key)) clauses.push(`${col}=${bind(params.get(key))}`);
  if (params.get("from"))
    clauses.push(`occurred_at>=${bind(params.get("from"))}`);
  if (params.get("to"))
    clauses.push(`occurred_at<=${bind(params.get("to") + "T23:59:59.999Z")}`);
  if (params.get("module"))
    clauses.push(`action LIKE ${bind(params.get("module") + ".%")}`);
  for (const key of ["role", "source", "status", "entityType"])
    if (params.get(key))
      clauses.push(
        `payload LIKE ${bind('%"' + key + '":' + JSON.stringify(params.get(key)) + "%")}`,
      );
  if (params.get("search")) {
    const p = bind(
      "%" +
        params
          .get("search")!
          .slice(0, 100)
          .replace(/[\\%_]/g, "\\$&") +
        "%",
    );
    clauses.push(
      `(LOWER(actor) LIKE LOWER(${p}) ESCAPE '\\' OR LOWER(action) LIKE LOWER(${p}) ESCAPE '\\' OR LOWER(application_id) LIKE LOWER(${p}) ESCAPE '\\' OR LOWER(payload) LIKE LOWER(${p}) ESCAPE '\\' OR id LIKE ${p} ESCAPE '\\')`,
    );
  }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const page = Math.max(1, Math.min(100000, Number(params.get("page")) || 1));
  return readTransaction(async (tx) => {
    const count = await tx.query(
      "SELECT COUNT(*) AS count FROM audit_logs" + where,
      values,
    );
    const rows = await tx.query(
      "SELECT * FROM audit_logs" +
        where +
        ` ORDER BY occurred_at DESC,id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`,
      values,
    );
    const events = rows.map((row) => {
      const payload = JSON.parse(String(row.payload));
      return (
        payload._event || {
          id: row.id,
          timestamp: row.occurred_at,
          actor: row.actor,
          role: "Not recorded",
          action: row.action,
          module: String(row.action).split(".")[0],
          entityType: row.application_id ? "Application" : "System",
          entityId: row.application_id,
          source: row.actor === "System" ? "System" : "User",
          status: "Recorded",
          details: auditDetails(payload),
        }
      );
    }) as AuditEvent[];
    return { events, total: Number(count[0]?.count || 0), page };
  });
}
