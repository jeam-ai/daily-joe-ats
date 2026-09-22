import "server-only";
import type { SheetsConfiguration } from "./sheets-management";
import {
  sheetsPrimary,
  gatewayRequest,
  gatewayConfigured,
} from "./sheets-gateway";
import { createRequire } from "node:module";
import type { HealthCheck } from "@/types/operations";
import type { Application, User } from "@/types";
import {
  readTransaction,
  transaction,
  readRecord,
  putRecord,
} from "./database";
import { withStore } from "./store";
import { config } from "./config";
import { accessToken } from "@/lib/google/gmail/service";
import { aiConfigured, aiModel, geminiProvider } from "./ai-provider";
import { aiUsage } from "./ai-assist";
import { withDeadline } from "./deadline";
import { writeAudit } from "./audit";
import { reportIssue, resolveIssue, recordIssue } from "./diagnostics";
import { pendingFailures, clearBufferedFailure } from "./diagnostic-buffer";
import { collectionSheets, entitySheets } from "@/lib/sheets-schema";

export interface HealthSnapshot {
  checkedAt?: string;
  checks: HealthCheck[];
}
const displayTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
const definitions = [
  ["database", "Database"],
  ["auth", "Google Authentication"],
  ["gmail", "Gmail Integration"],
  ["intake", "Gmail Application Sync"],
  ["sheets", "Spreadsheet Integration"],
  ["documents", "File / Resume Processing"],
  ["ocr", "OCR / Document Processing"],
  ["ai", "Gemini / AI Assist"],
  ["storage", "Application Storage"],
  ["jobs", "Background jobs"],
  ["mail", "Workflow email queue"],
  ["extraction", "AI Assist extraction"],
  ["timekeeping", "Timekeeping processing"],
  ["window", "Application intake window"],
];
type StoredRow = Record<string, unknown>;
type HealthStorage = {
  records: StoredRow[];
  applications: Application[];
  readable: boolean;
};
type IntakeHealth = {
  status: string;
  message: string;
  startedAt?: string;
  lastSuccessfulAt?: string;
  imported: number;
  pending: string[];
};
type BackgroundHealth = {
  status?: string;
  leaseUntil?: number;
};
const recordValue = <T>(
  snapshot: HealthStorage,
  collection: string,
  id: string,
): T | undefined => {
  const row = snapshot.records.find(
    (item) => item.collection === collection && item.id === id,
  );
  if (!row) return;
  try {
    return JSON.parse(String(row.payload)) as T;
  } catch {
    return;
  }
};
const collectionValues = <T>(snapshot: HealthStorage, collection: string) =>
  snapshot.records
    .filter((item) => item.collection === collection)
    .flatMap((item) => {
      try {
        return [JSON.parse(String(item.payload)) as T];
      } catch {
        return [];
      }
    });
function intakeHealth(snapshot: HealthStorage): IntakeHealth {
  const saved = recordValue<Partial<IntakeHealth>>(snapshot, "jobs", "gmail"),
    workspace = recordValue<{ intakePaused?: boolean }>(
      snapshot,
      "workspace",
      "main",
    ),
    state: IntakeHealth = {
      status: saved?.status || "idle",
      message: saved?.message || "No Gmail synchronization has been recorded.",
      startedAt: saved?.startedAt,
      lastSuccessfulAt: saved?.lastSuccessfulAt,
      imported: saved?.imported || 0,
      pending: Array.isArray(saved?.pending) ? saved.pending : [],
    };
  if (workspace?.intakePaused)
    return {
      ...state,
      status: "paused",
      message: "Gmail intake is paused. Resume it in Settings when ready.",
    };
  return state;
}
async function healthStorage(): Promise<HealthStorage> {
  if (sheetsPrimary()) {
    const collections = [
      "workspace",
      "sheets_configuration",
      "jobs",
      "sync",
      "email_index",
      "extraction_jobs",
      "timekeeping_jobs",
      // Loading this encrypted record verifies that private Drive storage is
      // readable without retrieving applicant document contents.
      "secure",
    ];
    const result = await gatewayRequest<{
      results: StoredRow[][];
    }>("loadMany", {
      queries: [
        ...collections.map((collection) => ({
          table: "records",
          ...(collection === "secure"
            ? {}
            : {
                tab:
                  collectionSheets[collection] || "Settings and Configuration",
              }),
          collection,
        })),
        { table: "applications", tab: entitySheets.applications },
        {
          table: "resumes",
          tab: entitySheets.resumes,
          metadataOnly: true,
        },
      ],
    });
    const applicationRows = result.results[collections.length] || [];
    return {
      records: result.results.slice(0, collections.length).flat(),
      applications: applicationRows.flatMap((row) => {
        try {
          return [JSON.parse(String(row.payload)) as Application];
        } catch {
          return [];
        }
      }),
      readable: true,
    };
  }
  return readTransaction(async (tx) => {
    const records = await tx.query("SELECT collection,id,payload FROM records");
    const applicationRows = await tx.query("SELECT payload FROM applications");
    await tx.query("SELECT id FROM resumes LIMIT 1");
    return {
      records,
      applications: applicationRows.flatMap((row) => {
        try {
          return [JSON.parse(String(row.payload)) as Application];
        } catch {
          return [];
        }
      }),
      readable: true,
    };
  });
}
export async function cachedHealth(): Promise<HealthSnapshot> {
  return (
    (await readTransaction((tx) =>
      readRecord<HealthSnapshot>(tx, "health", "latest"),
    )) || {
      checks: definitions.map(([id, service]) => ({
        id,
        service,
        status: "Not Verified",
        detail: "Select Check Now to verify this service.",
      })),
    }
  );
}
let inProgress: Promise<HealthSnapshot> | undefined;
export async function checkHealth() {
  if (inProgress) return inProgress;
  inProgress = performChecks().finally(() => {
    inProgress = undefined;
  });
  return inProgress;
}
async function performChecks(): Promise<HealthSnapshot> {
  // Health is observational. Document issues are recorded at ingestion/reprocessing;
  // scanning and writing every document here would turn checks into a bulk job.
  // One batched persistence read feeds every internal service card. Starting a
  // separate Apps Script request for each card would serialize behind the same
  // gateway lock and make later cards time out for reasons unrelated to health.
  const stored = withDeadline(healthStorage(), 12000).catch(() => null);
  const primaryStatus = sheetsPrimary()
    ? withDeadline(
        gatewayRequest<{ verified: boolean; revision: number }>("status"),
        10000,
      ).catch(() => null)
    : Promise.resolve(null);
  const check = async (
    id: string,
    work: () => Promise<Partial<HealthCheck>>,
  ): Promise<HealthCheck> => {
    const start = Date.now(),
      base = {
        id,
        service: definitions.find((d) => d[0] === id)![1],
        checkedAt: new Date().toISOString(),
        lastSuccess: undefined as string | undefined,
      };
    try {
      // Keep the complete dashboard inside the browser's request deadline. A
      // slow provider is reported as Not Verified without holding every other
      // independent service check behind it.
      const result = await withDeadline(work(), 10000);
      return {
        ...base,
        status: "Not Verified",
        detail: "Unable to verify this service right now.",
        ...result,
        responseMs: Date.now() - start,
        ...(result.status === "Healthy" ? { lastSuccess: base.checkedAt } : {}),
      };
    } catch {
      return {
        ...base,
        status: "Not Verified",
        responseMs: Date.now() - start,
        detail:
          "Unable to verify this service right now. Retry the check; this result does not confirm an outage.",
      };
    }
  };
  const checks = await Promise.all([
    check("database", async () => {
      try {
        if (sheetsPrimary()) {
          const status = await primaryStatus;
          if (!status) throw Error("Storage status unavailable");
          return {
            status: status.verified ? "Healthy" : "Attention Needed",
            detail: status.verified
              ? "Google Sheets storage is reachable and its migration is verified."
              : "Google Sheets migration requires verification.",
          };
        }
        await withDeadline(
          readTransaction(async (tx) => {
            await tx.query("SELECT 1 AS connected");
            await tx.query("SELECT id FROM audit_logs LIMIT 1");
            await tx.query("SELECT id FROM records LIMIT 1");
          }),
          12000,
        );
        return {
          status: "Healthy",
          detail:
            (sheetsPrimary()
              ? "Google Sheets transaction gateway"
              : process.env.PERSISTENCE_PROVIDER !== "local" &&
                  process.env.DATABASE_URL
                ? "PostgreSQL"
                : "Local SQLite") +
            " connectivity and required table reads verified. No schema changes were performed by this check.",
        };
      } catch {
        await reportIssue("database.unavailable");
        return {
          status: "Unavailable",
          detail:
            "Database connectivity could not be established. Ask an administrator to verify the service and connection configuration.",
        };
      }
    }),
    check("auth", async () => {
      config();
      const response = await fetch(
        "https://accounts.google.com/.well-known/openid-configuration",
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok)
        return {
          status: "Unavailable",
          detail: "Google sign-in discovery endpoint returned an error.",
        };
      return {
        status: "Healthy",
        detail:
          "Google sign-in discovery is reachable, local OAuth configuration is valid, and this request has an authorized session. A new interactive sign-in is not tested here.",
      };
    }),
    check("gmail", async () => {
      const c = await withStore(
        (s) => s.officialConnection || s.connection,
        false,
      );
      if (!c)
        return {
          status: "Not Configured",
          detail: "Connect the authorized careers mailbox.",
          href: "/settings/integrations",
          action: "Connect Gmail",
        };
      const token = await accessToken(c);
      const r = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!r.ok) {
        if (r.status === 401 || r.status === 403)
          await reportIssue("gmail.authorization");
        return {
          status: "Attention Needed",
          detail: "Gmail did not confirm mailbox access. Review authorization.",
          href: "/settings/integrations",
          action: "Review Gmail",
        };
      }
      const p = await r.json();
      return {
        status: "Healthy",
        detail: `Mailbox access verified: ${String(p.emailAddress)}.`,
        href: "/settings/integrations",
        action: "View Gmail",
      };
    }),
    check("intake", async () => {
      const snapshot = await stored;
      if (!snapshot) throw Error("Storage snapshot unavailable");
      const j = intakeHealth(snapshot);
      return {
        status: ["error", "authorization"].includes(j.status)
          ? "Attention Needed"
          : j.lastSuccessfulAt
            ? "Healthy"
            : "Not Verified",
        detail: `${j.message} Last attempt: ${displayTime(j.startedAt)}. Last successful sync: ${displayTime(j.lastSuccessfulAt)}. Latest run imported: ${j.imported}. Pending message IDs: ${j.pending.length}.`,
        href: "/settings/integrations",
        action: "View intake",
      };
    }),
    check("sheets", async () => {
      const snapshot = await stored;
      if (!snapshot) throw Error("Storage snapshot unavailable");
      const configured = recordValue<SheetsConfiguration>(
        snapshot,
        "sheets_configuration",
        "primary",
      );
      if (configured) {
        if (sheetsPrimary() && gatewayConfigured()) {
          const status = await primaryStatus;
          if (!status) throw Error("Storage status unavailable");
          return {
            status: status.verified ? "Healthy" : "Attention Needed",
            detail: `Google Sheets revision ${status.revision}. Schema: ${configured.schema || "Not checked"}. Migration: ${configured.migration?.status || "Not recorded"}.`,
            href: "/settings/data",
            action: "View storage",
          };
        }
        return {
          status: configured.error ? "Attention Needed" : "Not Verified",
          detail: `Workbook configured. Schema: ${configured.schema || "Not checked"}. Last successful operation: ${displayTime(configured.lastSuccess)}. Migration: ${configured.migration?.status || "Not started"}. Source database remains primary.`,
          href: "/settings/data",
          action: "Validate storage",
        };
      }
      if (!process.env.GOOGLE_SHEETS_ID)
        return {
          status: "Not Configured",
          detail:
            "A production spreadsheet is not configured. The local Excel tracker remains available.",
          href: "/settings/integrations",
          action: "View integration",
        };
      const c = await withStore((s) => s.sheetsConnection, false);
      if (!c)
        return {
          status: "Attention Needed",
          detail: "Spreadsheet authorization is required.",
          href: "/settings/integrations",
          action: "Authorize spreadsheet",
        };
      const token = await accessToken(c);
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_ID)}?fields=spreadsheetId`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      const sync = recordValue<{ at: string; revision: number }>(
        snapshot,
        "sync",
        "completed",
      );
      return {
        status: r.ok ? "Healthy" : "Attention Needed",
        detail: r.ok
          ? `Spreadsheet read access verified. Last confirmed sync: ${displayTime(sync?.at)}.`
          : "Spreadsheet access could not be confirmed.",
        href: "/settings/integrations",
        action: "View spreadsheet",
      };
    }),
    check("documents", async () => {
      const require = createRequire(import.meta.url);
      require.resolve("pdf-parse");
      require.resolve("mammoth");
      return {
        status: "Healthy",
        detail:
          "PDF and DOCX processing libraries are installed. This is a capability check; individual documents can still require review.",
      };
    }),
    check("ocr", async () => {
      const require = createRequire(import.meta.url);
      require.resolve("tesseract.js");
      return {
        status: "Not Verified",
        detail:
          "OCR library is installed. End-to-end OCR is checked during actual document processing; model availability and extraction accuracy are not inferred from installation.",
      };
    }),
    check("ai", async () => {
      if (!aiConfigured())
        return {
          status: "Not Configured",
          detail: "Gemini is optional. System Analysis remains available.",
          href: "/settings/ai",
          action: "View AI Integration",
        };
      try {
        await geminiProvider().check();
        return {
          status: "Healthy",
          detail: `Gemini model access verified: ${aiModel()}. No application was analyzed and no generation request was made. Recorded request failures remain available in the Error Center.`,
          href: "/settings/ai",
          action: "View AI Integration",
        };
      } catch {
        return {
          status: "Attention Needed",
          detail:
            "Gemini did not confirm access to the configured model. Verify the server key, model and provider availability.",
          href: "/settings/ai",
          action: "Review AI Integration",
        };
      }
    }),
    check("storage", async () => {
      const snapshot = await stored;
      if (!snapshot?.readable) throw Error("Storage snapshot unavailable");
      return {
        status: "Healthy",
        detail:
          "Application and encrypted document storage can be read. No applicant document content was retrieved by this check.",
      };
    }),
    ...(["mail", "extraction", "timekeeping"] as const).map((id) =>
      check(id, async () => {
        const collection =
          id === "mail"
            ? "email_index"
            : id === "extraction"
              ? "extraction_jobs"
              : "timekeeping_jobs";
        const snapshot = await stored;
        if (!snapshot) throw Error("Storage snapshot unavailable");
        const jobs = collectionValues<BackgroundHealth>(snapshot, collection);
        const failed = jobs.filter(
          (j) =>
            ["Failed", "Unconfirmed"].includes(j.status || "") ||
            (j.status === "Running" &&
              typeof j.leaseUntil === "number" &&
              j.leaseUntil < Date.now()),
        ).length;
        const queued = jobs.filter((j) =>
          ["Queued", "Running", "Sending"].includes(j.status || ""),
        ).length;
        const completed = jobs.filter((j) =>
          ["Sent", "Completed"].includes(j.status || ""),
        ).length;
        return {
          status: failed
            ? "Attention Needed"
            : jobs.length
              ? "Healthy"
              : "Not Verified",
          detail: `${queued} queued or processing · ${completed} completed · ${failed} require review. ${jobs.length ? "Based on persisted delivery and job records." : "No operations have been recorded yet."}`,
          href:
            id === "timekeeping"
              ? "/timekeeping"
              : id === "extraction"
                ? "/settings/ai"
                : "/settings/diagnostics",
          action: "View details",
        };
      }),
    ),
    check("window", async () => {
      const snapshot = await stored;
      if (!snapshot) throw Error("Storage snapshot unavailable");
      const real = snapshot.applications.filter(
        (a) => !a.isDemo && !a.deletedAt,
      );
      return {
        status: "Healthy",
        detail: `${real.filter((a) => a.queueState === "Active").length} active · ${real.filter((a) => a.queueState === "Queued").length} queued · ${real.filter((a) => a.queueState === "Closed").length} closed. Active membership is ordered by received time and capped at 100.`,
        href: "/applications",
        action: "View applications",
      };
    }),
    check("jobs", async () => {
      const snapshot = await stored;
      if (!snapshot) throw Error("Storage snapshot unavailable");
      const j = intakeHealth(snapshot);
      return {
        status: ["error", "authorization"].includes(j.status)
          ? "Attention Needed"
          : j.lastSuccessfulAt
            ? "Healthy"
            : "Not Verified",
        detail: `Durable Gmail worker: ${j.status}. Email, extraction and timekeeping jobs are shown separately.`,
        href: "/settings/integrations",
        action: "View worker",
      };
    }),
  ]);
  return { checkedAt: new Date().toISOString(), checks };
}

// Persisting a health snapshot requires a remote Sheets commit in production.
// It is audit work, not part of the interactive check result, so the route
// schedules it with Next.js `after()` and returns the verified results first.
export async function persistHealth(snapshot: HealthSnapshot, user: User) {
  await withDeadline(
    transaction(
      async (tx) => {
        await putRecord(tx, "health", "latest", snapshot);
        await writeAudit(tx, user.email, "health.checked", undefined, {
          services: snapshot.checks.map((c) => ({
            service: c.service,
            status: c.status,
          })),
        });
      },
      { lockKey: 812903 },
    ),
    10000,
  );
}
// Diagnostic persistence runs after the health response. It cannot hold the
// health UI behind an unrelated recruitment transaction.
export async function settleHealthDiagnostics(snapshot: HealthSnapshot) {
  if (snapshot.checks.find((c) => c.id === "database")?.status !== "Healthy")
    return;
  for (const pending of pendingFailures()) {
    try {
      await recordIssue(pending.category);
      clearBufferedFailure(pending.category);
    } catch {
      /* Keep the bounded fallback until a later successful check. */
    }
  }
  await resolveIssue("database.unavailable").catch(() => undefined);
  if (
    snapshot.checks.find((check) => check.id === "sheets")?.status === "Healthy"
  )
    await resolveIssue("sheets.sync", {}, true).catch(() => undefined);
}
export async function aiIntegration() {
  const health = await cachedHealth();
  return {
    configured: aiConfigured(),
    provider: "Gemini",
    model: aiModel(),
    health: health.checks.find((c) => c.id === "ai"),
    usage: await aiUsage(),
  };
}
