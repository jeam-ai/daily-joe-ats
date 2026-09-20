import "server-only";
import { createHash } from "node:crypto";
import type { DiagnosticIssue, DiagnosticSeverity } from "@/types/operations";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { writeAudit } from "./audit";
import { SafeError } from "./config";

// Only catalogued, sanitized messages enter diagnostics. Provider exceptions,
// headers and document content are never persisted or displayed.
const catalog = {
  "ai.rate_limit": {
    module: "AI Assist",
    severity: "Minor",
    title: "AI provider rate limit",
    message:
      "Gemini could not accept this request. System Analysis remains available.",
    steps: [
      "Wait before explicitly retrying AI Assist.",
      "Review provider usage in the Google AI console if this continues.",
    ],
  },
  "ai.timeout": {
    module: "AI Assist",
    severity: "Minor",
    title: "AI request timed out",
    message:
      "AI Assist did not finish within the allowed time. System Analysis is unchanged.",
    steps: [
      "Retry AI Assist from the applicant profile.",
      "If repeated, ask an administrator to check the provider service.",
    ],
  },
  "ai.invalid_response": {
    module: "AI Assist",
    severity: "Needs Attention",
    title: "AI response could not be verified",
    message:
      "The supplementary response failed evidence or format validation and was not accepted.",
    steps: [
      "Use System Analysis and review the source document.",
      "Retry explicitly or ask an administrator to review the AI provider.",
    ],
  },
  "ai.provider": {
    module: "AI Assist",
    severity: "Needs Attention",
    title: "AI provider unavailable",
    message:
      "Gemini could not complete the request. Other recruitment functions remain available.",
    steps: [
      "Check AI Integration settings.",
      "An administrator should verify the configured key and model.",
      "Retry when the provider is available.",
    ],
  },
  "gmail.timeout": {
    module: "Gmail",
    severity: "Minor",
    title: "Gmail synchronization timed out",
    message: "The mailbox operation could not finish in time.",
    steps: [
      "Retry synchronization.",
      "Check the Gmail service if failures continue.",
    ],
  },
  "gmail.authorization": {
    module: "Gmail",
    severity: "Needs Attention",
    title: "Gmail requires reauthorization",
    message: "The workspace cannot currently use the mailbox authorization.",
    steps: [
      "Open Gmail settings.",
      "Reconnect the authorized account.",
      "Retry synchronization after authorization succeeds.",
    ],
  },
  "gmail.sync": {
    module: "Gmail",
    severity: "Needs Attention",
    title: "Gmail synchronization failed",
    message: "The most recent synchronization could not complete.",
    steps: [
      "Review Gmail connection status.",
      "Retry synchronization.",
      "Contact the administrator if the issue persists.",
    ],
  },
  "documents.extraction": {
    module: "Documents",
    severity: "Needs Attention",
    title: "Document processing needs review",
    message:
      "The submitted document could not be fully processed. No recruitment decision was made.",
    steps: [
      "Open the original document and check readability.",
      "Retry document processing from the applicant profile.",
      "Record verified evidence manually if extraction remains incomplete.",
    ],
  },
  "sheets.sync": {
    module: "Spreadsheet",
    severity: "Needs Attention",
    title: "Spreadsheet synchronization failed",
    message: "The tracker has not confirmed the latest synchronization.",
    steps: [
      "Check spreadsheet access and the connected account.",
      "Retry synchronization in Integrations.",
      "Verify the latest tracker revision after recovery.",
    ],
  },
  "database.unavailable": {
    module: "Database",
    severity: "Critical",
    title: "Database connection unavailable",
    message: "The application could not verify access to its database.",
    steps: [
      "Check the database provider service status.",
      "Have an administrator verify deployment connection configuration.",
      "Review the most recent deployment.",
      "Retry the diagnostic check.",
      "Contact the developer if the issue persists.",
    ],
  },
  "jobs.failure": {
    module: "Background jobs",
    severity: "Needs Attention",
    title: "Background operation interrupted",
    message: "An operation did not report completion before its lease expired.",
    steps: [
      "Review the associated operation status before retrying.",
      "Use its supported retry action.",
      "Contact the administrator if the operation repeatedly stalls.",
    ],
  },
  "notification.failed": {
    module: "Notifications",
    severity: "Minor",
    title: "Notification delivery failed",
    message: "A requested notification was not confirmed as delivered.",
    steps: [
      "Check delivery history before retrying to avoid duplicates.",
      "Review the configured delivery service.",
    ],
  },
  "export.failed": {
    module: "Exports",
    severity: "Minor",
    title: "Export could not be generated",
    message: "The requested report could not be generated.",
    steps: ["Retry the export.", "Check the selected data and filters."],
  },
  "timekeeping.failed": {
    module: "Timekeeping",
    severity: "Needs Attention",
    title: "Timekeeping operation failed",
    message:
      "The attendance operation did not complete. Review the saved batch before retrying.",
    steps: [
      "Check the source files and mapping.",
      "Reopen the batch to verify its current state.",
      "Retry the supported action.",
    ],
  },
  "server.failure": {
    module: "Application",
    severity: "Critical",
    title: "Application operation failed",
    message: "An unexpected server operation failed.",
    steps: [
      "Refresh to verify whether the requested change was saved.",
      "Retry only after checking the current record.",
      "Contact the administrator if the issue persists.",
    ],
  },
} satisfies Record<
  string,
  {
    module: string;
    severity: DiagnosticSeverity;
    title: string;
    message: string;
    steps: string[];
  }
>;
export type IssueCategory = keyof typeof catalog;
export const issueCatalog = catalog;
export const unresolved = (issue: DiagnosticIssue) =>
  !["Automatically Resolved", "Fixed", "Closed"].includes(issue.status);
export async function recordIssue(
  category: IssueCategory,
  context: { entityId?: string; user?: string; jobId?: string } = {},
  tx?: Transaction,
) {
  const work = async (db: Transaction) => {
    const entry = catalog[category];
    const key = createHash("sha256")
      .update(
        category + ":" + (context.entityId || "") + ":" + (context.jobId || ""),
      )
      .digest("hex")
      .slice(0, 32);
    const previous = await readRecord<DiagnosticIssue>(db, "diagnostics", key);
    const now = new Date().toISOString();
    const issue: DiagnosticIssue = {
      ...entry,
      id: key,
      key,
      category,
      firstAt: previous?.firstAt || now,
      lastAt: now,
      occurrences: (previous?.occurrences || 0) + 1,
      recoveryAttempts: previous?.recoveryAttempts || 0,
      status:
        previous && !unresolved(previous)
          ? "Recurring"
          : entry.severity === "Critical"
            ? "Needs Developer Action"
            : entry.severity === "Needs Attention"
              ? "Needs Human Action"
              : "Active",
      affected: [entry.module],
      unaffected: category.startsWith("ai.")
        ? ["System Analysis", "Applicant workflow", "Gmail", "Timekeeping"]
        : [],
      ...context,
      history: [
        ...(previous?.history || []),
        { at: now, action: "Detected", actor: "System" },
      ].slice(-50),
    };
    if (issue.occurrences >= 3 && issue.severity === "Minor") {
      issue.severity = "Needs Attention";
      if (issue.status !== "Recurring") issue.status = "Needs Human Action";
    }
    issue.auditId = await writeAudit(
      db,
      "System",
      "diagnostics.detected",
      context.entityId,
      {
        category,
        diagnosticId: key,
        occurrence: issue.occurrences,
        severity: issue.severity,
        status: issue.status,
        jobId: context.jobId,
      },
    );
    await putRecord(db, "diagnostics", key, issue);
    return issue;
  };
  return tx ? work(tx) : transaction(work);
}
export async function resolveIssue(
  category: IssueCategory,
  context: { entityId?: string; jobId?: string } = {},
  automatic = false,
) {
  return transaction(async (tx) => {
    const key = createHash("sha256")
      .update(
        category + ":" + (context.entityId || "") + ":" + (context.jobId || ""),
      )
      .digest("hex")
      .slice(0, 32);
    const issue = await readRecord<DiagnosticIssue>(tx, "diagnostics", key);
    if (!issue || !unresolved(issue)) return;
    issue.status = automatic ? "Automatically Resolved" : "Fixed";
    issue.resolvedAt = new Date().toISOString();
    issue.resolvedBy = "System";
    issue.resolution = "A subsequent operation completed successfully.";
    issue.history.push({
      at: issue.resolvedAt,
      action: issue.resolution,
      actor: "System",
    });
    issue.history = issue.history.slice(-50);
    await putRecord(tx, "diagnostics", key, issue);
    await writeAudit(tx, "System", "diagnostics.resolved", context.entityId, {
      diagnosticId: key,
      automatic,
      resolution: issue.resolution,
    });
  });
}
export async function recoveryAttempt(category: IssueCategory) {
  return transaction(async (tx) => {
    const key = createHash("sha256")
        .update(category + "::")
        .digest("hex")
        .slice(0, 32),
      issue = await readRecord<DiagnosticIssue>(tx, "diagnostics", key);
    if (!issue || !unresolved(issue)) return;
    issue.status = "Retrying";
    issue.recoveryAttempts++;
    issue.history.push({
      at: new Date().toISOString(),
      actor: "System",
      action: "Allowlisted retry attempted",
    });
    issue.history = issue.history.slice(-50);
    await putRecord(tx, "diagnostics", key, issue);
    await writeAudit(tx, "System", "diagnostics.retrying", undefined, {
      diagnosticId: key,
      attempt: issue.recoveryAttempts,
      category,
    });
  });
}
export async function diagnosticHistory() {
  return readTransaction(async (tx) =>
    (
      await tx.query(
        "SELECT payload FROM records WHERE collection=$1 ORDER BY id",
        ["diagnostics"],
      )
    )
      .map((r) => JSON.parse(String(r.payload)) as DiagnosticIssue)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
  );
}
export async function markDiagnostic(id: string, actor: string, note: string) {
  if (note.trim().length < 10)
    throw new SafeError(
      "Describe how you verified the resolution (at least 10 characters).",
    );
  return transaction(async (tx) => {
    const issue = await readRecord<DiagnosticIssue>(tx, "diagnostics", id);
    if (!issue) throw new SafeError("Diagnostic not found.", 404);
    issue.status = "Closed";
    issue.resolvedBy = actor;
    issue.resolvedAt = new Date().toISOString();
    issue.resolution = note.slice(0, 500);
    issue.history.push({
      at: issue.resolvedAt,
      actor,
      action: "Closed following manual verification",
    });
    issue.history = issue.history.slice(-50);
    await putRecord(tx, "diagnostics", id, issue);
    await writeAudit(tx, actor, "diagnostics.closed", issue.entityId, {
      diagnosticId: id,
      resolution: issue.resolution,
    });
  });
}
// Diagnostics must never replace the original failure or block unrelated work.
export async function reportIssue(
  category: IssueCategory,
  context: { entityId?: string; user?: string; jobId?: string } = {},
) {
  try {
    await recordIssue(category, context);
  } catch {
    console.error(
      "Daily Joe Careers: diagnostic persistence unavailable",
      category,
    );
  }
}
