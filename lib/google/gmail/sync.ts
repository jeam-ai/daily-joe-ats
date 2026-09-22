import {
  reportIssue,
  resolveIssue,
  recoveryAttempt,
} from "@/lib/server/diagnostics";
import { matchHiringNeed } from "@/lib/intake-matching";
import "server-only";
import { previewImport, confirmImport, official, gmail } from "./intake";
import { accessToken } from "./service";
import {
  retryableTransaction,
  readTransaction,
  readRecord,
  putRecord,
} from "@/lib/server/database";
import { getState } from "@/lib/server/repository";
import {
  intakeCapacity,
  canManage,
  INTAKE_QUEUE_LIMIT,
} from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import type { User } from "@/types";

export type IntakeSync = {
  status:
    | "idle"
    | "checking"
    | "processing"
    | "complete"
    | "capacity"
    | "error"
    | "authorization"
    | "paused";
  message: string;
  startedAt?: string;
  completedAt?: string;
  runId?: string;
  leaseUntil?: number;
  imported: number;
  checked: number;
  pending: string[];
  page?: string;
  query?: string;
  issues: { message: string; reason: string }[];
  retryAt?: number;
  failures?: number;
  consecutiveFailures?: number;
  lastSuccessfulAt?: string;
  errorCode?: string;
  headCheckedAt?: number;
  seenIds?: string[];
};
// Resume extraction (especially OCR) is the expensive part of intake. Keep
// automatic batches small enough to finish, persist, and release their lease
// inside a serverless invocation; the browser/cron immediately continues the
// remaining durable queue.
export const AUTOMATIC_INTAKE_BATCH_SIZE = 5;
const empty = (): IntakeSync => ({
  status: "idle",
  message: "Ready to check the careers mailbox.",
  imported: 0,
  checked: 0,
  pending: [],
  issues: [],
});
export async function intakeStatus() {
  return readTransaction(async (tx) => {
    const state =
      (await readRecord<IntakeSync>(tx, "jobs", "gmail")) || empty();
    const workspace = await readRecord<{ intakePaused?: boolean }>(
      tx,
      "workspace",
      "main",
    );
    if (workspace?.intakePaused)
      return {
        ...state,
        status: "paused" as const,
        message:
          "Gmail intake is paused. Resume it in Settings when you are ready.",
      };
    if (
      state.leaseUntil &&
      state.leaseUntil < Date.now() &&
      ["checking", "processing"].includes(state.status)
    ) {
      state.status = "error";
      state.message = "The last sync was interrupted. Retry to resume safely.";
      delete state.runId;
      delete state.leaseUntil;
    }
    return state;
  });
}
// A durable lease serializes cron, login and browser triggers. Each invocation
// processes a small resumable batch; 100 is active capacity, not a lifetime limit.
export async function syncIntake(
  requestedBy?: User,
  force = false,
  budgetMs = 210000,
) {
  const workspace = await readTransaction(getState);
  if (workspace.intakePaused) return;
  const actor = requestedBy
    ? workspace.users?.find((u) => u.email === requestedBy.email && u.active)
    : workspace.users?.find((u) => u.active && u.role === "Admin");
  if (!actor || !canManage(actor)) return;
  const runId = crypto.randomUUID(),
    now = Date.now();
  const claimed = await retryableTransaction(async (tx) => {
    const job = (await readRecord<IntakeSync>(tx, "jobs", "gmail")) || empty();
    if (job.leaseUntil && job.leaseUntil > now) return null;
    if (!force && (job.consecutiveFailures || 0) >= 3) return null;
    if (force) job.consecutiveFailures = 0;
    const capacityFreed =
      job.status === "capacity" && !intakeCapacity(workspace.applications).full;
    if (!force && !capacityFreed && job.retryAt && job.retryAt > now)
      return null;
    Object.assign(job, {
      runId,
      // The browser route may spend additional time committing and
      // checkpointing after its document-processing budget. Keep the lease
      // aligned with the 240-second serverless ceiling so a status poll never
      // starts a second writer while the original invocation is still alive.
      leaseUntil: now + Math.max(budgetMs + 20000, 230000),
      status: "checking",
      startedAt: new Date(now).toISOString(),
      message: "Checking the official mailbox…",
      imported: 0,
      checked: 0,
    });
    await putRecord(tx, "jobs", "gmail", job);
    return job;
  });
  if (!claimed) return;
  const job = claimed;
  async function checkpoint() {
    await retryableTransaction(async (tx) => {
      const current = await readRecord<IntakeSync>(tx, "jobs", "gmail");
      if (current?.runId !== runId)
        throw new SafeError(
          "A newer sync has taken over. Reload the sync status.",
          409,
        );
      await putRecord(tx, "jobs", "gmail", job);
    });
  }
  try {
    if (job.consecutiveFailures) await recoveryAttempt("gmail.timeout");
    const connection = await official(),
      token = await accessToken(connection);
    const profile = await gmail<{ emailAddress: string }>(token, "profile");
    if (profile.emailAddress.toLowerCase() !== connection.email.toLowerCase())
      throw new SafeError(
        "The connected account does not match the official mailbox.",
        401,
      );
    const query = workspace.intakeQuery?.trim();
    if (!query)
      throw new SafeError(
        "Set an application email filter in Recruitment settings.",
      );
    if (job.query !== query) {
      job.pending = [];
      delete job.page;
      job.query = query;
    }
    // Revisit the mailbox head independently of the older-page cursor.
    // New arrivals must not wait behind a full window or a large backlog.
    if (!job.headCheckedAt || now - job.headCheckedAt > 30000) {
      const head = await gmail<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(token, `messages?maxResults=100&q=${encodeURIComponent(query)}`);
      const known = new Set([
        ...workspace.applications.map((a) => a.gmailMessageId),
        ...(job.seenIds || []),
      ]);
      const fresh = (head.messages || [])
        .map((m) => m.id)
        .filter((id) => !known.has(id));
      if (!job.pending.length && !job.page) job.page = head.nextPageToken;
      job.pending = [...new Set([...fresh, ...job.pending])];
      job.headCheckedAt = now;
    }
    // Continue checking new message IDs, but do not read documents or consume
    // the historical cursor while retained eligible intake is at capacity.
    if (intakeCapacity((await readTransaction(getState)).applications).full) {
      job.pending = job.pending.slice(0, INTAKE_QUEUE_LIMIT);
      job.status = "capacity";
      job.message = `Intake capacity is full: ${INTAKE_QUEUE_LIMIT} eligible applications retained, with 100 active. Gmail monitoring continues. Close an application to make room; unimported messages remain in Gmail.`;
      return;
    }
    if (!job.pending.length) {
      const page = await gmail<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(
        token,
        `messages?maxResults=100&q=${encodeURIComponent(query)}${job.page ? `&pageToken=${encodeURIComponent(job.page)}` : ""}`,
      );
      job.pending = (page.messages || []).map((m) => m.id);
      job.page = page.nextPageToken;
      await checkpoint();
    }
    const ids = job.pending.slice(0, AUTOMATIC_INTAKE_BATCH_SIZE);
    if (!ids.length) {
      job.status = "complete";
      job.message = "Mailbox checked. No new eligible applications.";
      return;
    }
    job.status = "processing";
    job.message = "Reading resumes and checking hiring-need qualifications…";
    const preview = await previewImport(actor, {
      ids,
      // Leave enough time for the preview, normalized application rows and
      // final job checkpoint to commit to Sheets after document processing.
      deadline: now + Math.max(1000, budgetMs - 50000),
      automatic: true,
    });
    job.checked = preview.scanned;
    // Public preview rows deliberately omit email body and resume content.
    // Automatic intake retains its in-memory preview only for this one
    // transaction so matching can use the submitted message without storing
    // another binary-heavy preview record.
    const automaticRows = preview.automaticPreview?.rows;
    const selections = preview.rows.map((row) => {
      const submitted = automaticRows?.find(
        (candidate) => candidate.messageId === row.messageId,
      );
      return {
        messageId: row.messageId,
        name:
          row.name ||
          "Applicant name was not clearly stated in the submitted application.",
        hiringNeedId:
          // A submitted role or preferred branch is often written in the email
          // body rather than its generic subject. Matching is advisory only and
          // never replaces the separately recorded submitted position/location.
          matchHiringNeed(
            `${row.subject}\n${submitted?.emailBody || ""}`,
            workspace.hiringNeeds,
          )?.id || "",
      };
    });
    // Re-read the grant before committing; disconnecting stops pending imports.
    const currentConnection = await official();
    if (currentConnection.connectedAt !== connection.connectedAt)
      throw new SafeError(
        "Mailbox authorization changed. Retry with the current connection.",
        409,
      );
    if (selections.length) {
      const result = await confirmImport(
        actor,
        preview.id,
        selections,
        true,
        true,
        preview.automaticPreview,
      );
      job.imported = result.imported;
    }
    const full = intakeCapacity(
      (await readTransaction(getState)).applications,
    ).full;
    if (full) {
      job.status = "capacity";
      job.message = `Intake capacity reached (${INTAKE_QUEUE_LIMIT}). Remaining messages are retained in Gmail and will be retried when space becomes available.`;
      return;
    }
    const retryIds = preview.issues.filter((i) =>
      /Failed to retrieve|time limit|Failed to read/.test(i.reason),
    );
    // Failed extraction must remain retryable; keep this bounded batch pending.
    job.failures = retryIds.length ? (job.failures || 0) + 1 : 0;
    const retryBatch = retryIds.length > 0 && job.failures < 3;
    if (!retryIds.length || job.failures >= 3) {
      job.pending = job.pending.slice(ids.length);
      job.seenIds = [...new Set([...(job.seenIds || []), ...ids])].slice(-5000);
    }
    if (job.failures >= 3) job.failures = 0; // Continue past unreadable mail; issues remain visible and a later scan retries it.
    job.issues = [
      ...new Map(
        [
          ...job.issues,
          ...preview.issues.filter((i) => !i.reason.startsWith("Duplicate")),
        ].map((issue) => [issue.message, issue]),
      ).values(),
    ]
      .reverse()
      .slice(0, 40);
    job.status = retryBatch ? "error" : "complete";
    job.message = retryBatch
      ? "Some messages could not be read. Retry to resume this batch."
      : retryIds.length
        ? "Unreadable attachments need HR review. Other applications will continue importing automatically."
        : job.imported
          ? `${job.imported} new application${job.imported === 1 ? "" : "s"} imported. ${job.pending.length || job.page ? "More messages will be checked automatically." : "Mailbox check complete."}`
          : "No new eligible applications in this batch.";
  } catch (error) {
    const e = error as SafeError;
    job.errorCode =
      error instanceof SafeError
        ? `safe-${error.status}`
        : error instanceof Error
          ? error.name || "unexpected"
          : "unexpected";
    job.status =
      e.status === 401 ||
      (e.status === 409 && /Connect|Authorize/.test(e.message))
        ? "authorization"
        : "error";
    await reportIssue(
      !(error instanceof SafeError)
        ? "server.failure"
        : job.status === "authorization"
          ? "gmail.authorization"
          : e.status === 504 || /timeout|timed out/i.test(e.message || "")
            ? "gmail.timeout"
            : "gmail.sync",
    );
    job.message =
      error instanceof SafeError &&
      !/configuration|DATABASE_URL|security keys|OAuth URLs/.test(error.message)
        ? error.message
        : "Gmail sync could not finish. Retry to resume safely.";
  } finally {
    if (["error", "authorization"].includes(job.status)) {
      job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
      if (job.status === "authorization" || job.consecutiveFailures >= 3) {
        job.consecutiveFailures = 3;
        job.message +=
          " Automatic retries paused. Review the issue and retry explicitly.";
      }
    } else {
      const recovered = !!job.consecutiveFailures;
      job.consecutiveFailures = 0;
      delete job.errorCode;
      if (job.status === "complete")
        job.lastSuccessfulAt = new Date().toISOString();
      if (recovered)
        for (const category of [
          "gmail.timeout",
          "gmail.sync",
          "gmail.authorization",
        ] as const)
          await resolveIssue(category, {}, true).catch(() => {});
    }
    job.completedAt = new Date().toISOString();
    job.leaseUntil = 0;
    job.retryAt =
      Date.now() +
      (job.status === "error"
        ? 120000
        : job.status === "capacity"
          ? 30000
          : job.pending.length || job.page
            ? 5000
            : 60000);
    await checkpoint().catch(() => {});
  }
}
