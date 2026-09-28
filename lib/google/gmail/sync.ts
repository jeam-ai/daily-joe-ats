import {
  reportIssue,
  resolveIssue,
  recoveryAttempt,
} from "@/lib/server/diagnostics";
import { matchHiringNeed } from "@/lib/intake-matching";
import "server-only";
import {
  MAX_GMAIL_IMPORT_BATCH_SIZE,
  previewImport,
  confirmImport,
  official,
  gmail,
} from "./intake";
import { accessToken } from "./service";
import {
  aivenConfigured,
  postgresConfigured,
  retryableTransaction,
  readTransaction,
  readRecord,
  putRecord,
} from "@/lib/server/database";
import { getState, saveState } from "@/lib/server/repository";
import { canManage } from "@/lib/data-policy";
import { SafeError } from "@/lib/server/config";
import { ensureRecruitmentConfiguration } from "@/lib/server/recruitment-configuration";
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
  /** Versioned only for the resumable queue, never applicant data. */
  queueVersion?: number;
  headCheckedAt?: number;
  seenIds?: string[];
  /** IDs known to have come from Gmail's newest-first mailbox head. */
  latestPending?: string[];
  /** Continuation token for the three-day latest/recovery sweep. */
  recentPage?: string;
  recentWindowQuery?: string;
  /** Safe, count-only explanation of the most recent Gmail eligibility check. */
  latestDiagnostics?: {
    matching: number;
    alreadyImported: number;
    alreadyQueued: number;
    alreadyChecked: number;
    available: number;
    hasMoreRecentPages: boolean;
    /** A bounded attachment sweep ran after the configured label was empty. */
    recoveredFromRecentAttachments?: boolean;
  };
  /** Historical IDs are kept separately so they can never outrank new mail. */
  backfillPending?: string[];
  queuePolicyVersion?: number;
  lastNewEligibleAt?: number;
  nextBackfillAt?: number;
  /** Calendar month currently being recovered, e.g. 2026-08. */
  backfillMonth?: string;
  backfillImportedThisMonth?: number;
  backfillCompletedMonths?: string[];
  backfillPausedReason?: string;
  backfillStoragePercent?: number;
  backfillComplete?: boolean;
  batchLimit?: number;
  batchChecked?: number;
  batchImported?: number;
  phase?: "latest" | "backfill" | "cooldown" | "idle";
  lastBatchPhase?: "latest" | "backfill";
  nextPhase?: "latest" | "backfill";
  nextSyncAt?: number;
  databaseState?: "processing" | "saved" | "queued";
  lastDatabaseCommitAt?: string;
};
// Process up to fifteen messages per automatic pass. Resume extraction has a
// separate deadline/fallback so a slow document cannot hold the whole batch;
// the browser/cron continues any remaining durable queue on later passes.
export const AUTOMATIC_INTAKE_BATCH_SIZE = MAX_GMAIL_IMPORT_BATCH_SIZE;
// A successful batch deliberately leaves room for Aiven to finish its prior
// transaction. The checkpoint is durable, so a browser, cron, or later login
// can safely resume without duplicate Gmail imports.
// One minute after a confirmed commit gives Aiven time to release the prior
// write while keeping current applicants moving through the queue promptly.
export const INTAKE_COOLDOWN_MS = 60 * 1000;
// Version 3 introduces a separate three-day latest/recovery cursor. The
// rebase discards only unimported queue pointers; applications already
// committed to the ATS remain untouched and are still de-duplicated.
export const INTAKE_QUEUE_VERSION = 3;
export const NEW_INTAKE_QUIET_PERIOD_MS = 6 * 60 * 60 * 1000;
export const BACKFILL_MONTHLY_LIMIT = 60;
const BACKFILL_QUEUE_POLICY_VERSION = 2;
const BACKFILL_STORAGE_WARNING = 0.7;
// Background work may be stopped by a serverless host before its advertised
// route limit. A durable job can be safely reclaimed after this interval: its
// application writes use stable Gmail IDs and its checkpoint rejects an older
// run ID, so reclaiming never creates a second import of the same message.
const STALE_INTAKE_WORKER_MS = 90000;
const empty = (): IntakeSync => ({
  status: "idle",
  message: "Ready to check the careers mailbox.",
  imported: 0,
  checked: 0,
  pending: [],
  issues: [],
});

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(key: string) {
  const [year, month] = key.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function gmailMonthQuery(query: string, key: string) {
  const [year, month] = key.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const date = (value: Date) =>
    `${value.getUTCFullYear()}/${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}`;
  return `${query} after:${date(start)} before:${date(end)}`;
}

/** Keep Gmail's safety exclusions but remove only label terms for recovery. */
function queryWithoutLabels(query: string) {
  return query
    .replace(/\blabel\s*:\s*(?:"[^"]+"|'[^']+'|\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function recentAttachmentRecoveryQuery(query: string) {
  const base = queryWithoutLabels(query) || "-in:spam -in:trash -in:sent";
  return `${base} has:attachment newer_than:3d`;
}

/** Historical intake is optional work, so it fails closed when capacity is not safe. */
async function backfillStorageStatus() {
  if (!postgresConfigured()) return { blocked: false as const };
  try {
    const result = await readTransaction(async (tx) => {
      const storage = Number(
        (
          await tx.query("SELECT pg_database_size(current_database()) AS bytes")
        )[0]?.bytes || 0,
      );
      const connectionLimit = aivenConfigured()
        ? String(
            (
              await tx.query("SELECT current_setting('max_connections') AS n")
            )[0]?.n || "",
          )
        : "";
      const configuredLimit = Number(process.env.DB_STORAGE_LIMIT_BYTES || 0);
      const limit =
        configuredLimit || (connectionLimit === "20" ? 1024 ** 3 : 0);
      return limit > 0 ? storage / limit : null;
    });
    return result !== null && result >= BACKFILL_STORAGE_WARNING
      ? { blocked: true as const, percent: Math.round(result * 100) }
      : {
          blocked: false as const,
          percent: result ? Math.round(result * 100) : undefined,
        };
  } catch {
    return { blocked: true as const };
  }
}
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
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0;
    const stalled =
      ["checking", "processing"].includes(state.status) &&
      ((state.leaseUntil && state.leaseUntil < Date.now()) ||
        !startedAt ||
        Date.now() - startedAt > STALE_INTAKE_WORKER_MS);
    if (stalled) {
      state.status = "error";
      state.message =
        "The last Gmail check stopped before completion. Retrying safely from the saved queue…";
      delete state.runId;
      delete state.leaseUntil;
    }
    // This was an old manual-preview message that could be retained by a
    // previously interrupted automatic run. Automatic intake now retains a
    // ready email/document fallback instead of producing this review item.
    // Do not keep presenting obsolete work as a current Gmail failure.
    state.issues = state.issues.filter(
      (issue) =>
        !(
          issue.message === "Import preview" &&
          /Preview time limit reached/i.test(issue.reason)
        ),
    );
    return state;
  });
}

/**
 * Discard only the resumable Gmail cursor. Existing application records and
 * their Gmail message IDs remain intact, so the following pass safely starts
 * over and skips anything already imported.
 */
export async function restartQueuedIntake(requestedBy: User) {
  if (!canManage(requestedBy))
    throw new SafeError("Recruitment manager access required.", 403);
  return retryableTransaction(async (tx) => {
    const workspace = await getState(tx);
    const actor = workspace.users?.find(
      (user) => user.email === requestedBy.email && user.active,
    );
    if (!actor || !canManage(actor))
      throw new SafeError("Recruitment manager access required.", 403);
    const job = (await readRecord<IntakeSync>(tx, "jobs", "gmail")) || empty();
    Object.assign(job, empty(), {
      message:
        "Queued Gmail backlog cleared. Restarting from the newest eligible applications…",
      query: workspace.intakeQuery?.trim(),
      queueVersion: INTAKE_QUEUE_VERSION,
    });
    delete job.page;
    delete job.seenIds;
    delete job.latestPending;
    delete job.recentPage;
    delete job.recentWindowQuery;
    delete job.backfillPending;
    delete job.backfillComplete;
    delete job.nextBackfillAt;
    delete job.backfillPausedReason;
    delete job.retryAt;
    delete job.nextSyncAt;
    delete job.nextPhase;
    delete job.runId;
    delete job.leaseUntil;
    delete job.databaseState;
    delete job.lastDatabaseCommitAt;
    await putRecord(tx, "jobs", "gmail", job);
    return job;
  });
}
// A durable lease serializes cron, login and browser triggers. Each invocation
// processes a small resumable batch; 100 is active capacity, not a lifetime limit.
export async function syncIntake(
  requestedBy?: User,
  force = false,
  budgetMs = 210000,
): Promise<IntakeSync | undefined> {
  let workspace = await readTransaction(getState);
  if (workspace.intakePaused) return undefined;
  const actor = requestedBy
    ? workspace.users?.find((u) => u.email === requestedBy.email && u.active)
    : workspace.users?.find((u) => u.active && u.role === "Admin");
  if (!actor || !canManage(actor)) return undefined;
  const runId = crypto.randomUUID(),
    now = Date.now();
  const claimed = await retryableTransaction(async (tx) => {
    const configuredState = await getState(tx);
    const repaired = ensureRecruitmentConfiguration(configuredState);
    if (repaired) await saveState(tx, configuredState, { sync: false });
    const job = (await readRecord<IntakeSync>(tx, "jobs", "gmail")) || empty();
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : 0;
    const staleWorker =
      ["checking", "processing"].includes(job.status) &&
      (!startedAt || now - startedAt > STALE_INTAKE_WORKER_MS);
    if (job.leaseUntil && job.leaseUntil > now && !staleWorker) return null;
    if (staleWorker) {
      job.status = "error";
      job.message =
        "The previous Gmail check stopped before completion. Resuming safely from the saved queue…";
      delete job.runId;
      delete job.leaseUntil;
    }
    // Rebase the legacy historical cursor once. This fulfils the safe-restart
    // behavior without deleting any saved applications: only uncommitted
    // Gmail queue state is removed, and the next pass starts at the mailbox
    // head while Gmail IDs prevent duplicate imports.
    if (job.queueVersion !== INTAKE_QUEUE_VERSION) {
      job.pending = [];
      job.queueVersion = INTAKE_QUEUE_VERSION;
      delete job.page;
      delete job.seenIds;
      delete job.latestPending;
      delete job.recentPage;
      delete job.recentWindowQuery;
      delete job.retryAt;
      delete job.nextSyncAt;
      delete job.nextPhase;
    }
    // Policy version two makes history a bounded calendar-month recovery.
    // Keep known latest work, but reset only old historical queue pointers so
    // they can be rediscovered in deterministic month order. No saved
    // application is affected; Gmail IDs still de-duplicate every import.
    if (job.queuePolicyVersion !== BACKFILL_QUEUE_POLICY_VERSION) {
      const newest = new Set(job.latestPending || []);
      const pending = job.pending || [];
      job.pending = pending.filter((id) => newest.has(id));
      job.latestPending = job.latestPending?.filter((id) =>
        job.pending.includes(id),
      );
      if (!job.latestPending?.length) delete job.latestPending;
      delete job.backfillPending;
      delete job.page;
      delete job.backfillMonth;
      delete job.backfillImportedThisMonth;
      delete job.backfillCompletedMonths;
      delete job.backfillComplete;
      delete job.nextBackfillAt;
      delete job.backfillPausedReason;
      job.lastNewEligibleAt ||= now;
      job.queuePolicyVersion = BACKFILL_QUEUE_POLICY_VERSION;
    }
    if (!force && (job.consecutiveFailures || 0) >= 3) return null;
    if (force) job.consecutiveFailures = 0;
    // Automatic browser and cron passes honor the successful-save cooldown.
    // `force` is reserved for an explicit operator recovery action.
    if (!force && job.retryAt && job.retryAt > now) return null;
    Object.assign(job, {
      runId,
      // Keep the lease close to the bounded worker budget. If a host stops a
      // background task unexpectedly, the next polling cycle can resume from
      // the durable message queue instead of leaving the UI on "Checking".
      leaseUntil: now + Math.max(90000, Math.min(budgetMs + 20000, 120000)),
      status: "checking",
      startedAt: new Date(now).toISOString(),
      message: "Checking the official mailbox…",
      imported: 0,
      checked: 0,
      batchLimit: AUTOMATIC_INTAKE_BATCH_SIZE,
      batchChecked: 0,
      batchImported: 0,
      phase: "latest",
      databaseState: "processing",
    });
    delete job.nextSyncAt;
    delete job.nextPhase;
    await putRecord(tx, "jobs", "gmail", job);
    return job;
  });
  if (!claimed) return undefined;
  // Configuration repair can upgrade the shipped legacy Gmail filter. Reload
  // it before asking Gmail so the very first sync uses the corrected query.
  workspace = await readTransaction(getState);
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
  let stage = "mailbox-authorization";
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
      delete job.seenIds;
      delete job.latestPending;
      delete job.backfillPending;
      delete job.nextBackfillAt;
      delete job.backfillPausedReason;
      delete job.lastNewEligibleAt;
      delete job.recentPage;
      delete job.recentWindowQuery;
      delete job.backfillComplete;
      job.query = query;
    }
    job.message = "Finding new eligible applications in the official mailbox…";
    await checkpoint();
    // Always inspect the most recent three days before a saved historical
    // cursor. Gmail can return more than one 100-message page during a busy
    // day, so retain a separate recent cursor and recover every unimported
    // labelled application in that window as *latest* work—not backfill.
    stage = "mailbox-head";
    let recentQuery = `${query} newer_than:3d`;
    if (job.recentWindowQuery !== recentQuery) {
      delete job.recentPage;
      job.recentWindowQuery = recentQuery;
    }
    let head = await gmail<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>(token, `messages?maxResults=100&q=${encodeURIComponent(recentQuery)}`);
    // A stale/renamed Gmail label must not produce a false empty-mailbox
    // result. This fallback is limited to the last three days and attachment
    // mail; previewImport applies a second application-evidence check before
    // a record can be created.
    const recoveredFromRecentAttachments =
      !(head.messages || []).length && /\blabel\s*:/i.test(query);
    if (recoveredFromRecentAttachments) {
      recentQuery = recentAttachmentRecoveryQuery(query);
      head = await gmail<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(token, `messages?maxResults=100&q=${encodeURIComponent(recentQuery)}`);
    }
    const queued = new Set([...job.pending, ...(job.backfillPending || [])]);
    const imported = new Set(
      workspace.applications
        .map((application) => application.gmailMessageId)
        .filter((id): id is string => !!id),
    );
    const previouslyChecked = new Set(job.seenIds || []);
    const headIds = (head.messages || []).map((message) => message.id);
    const fresh = headIds.filter(
      (id) =>
        !imported.has(id) && !previouslyChecked.has(id) && !queued.has(id),
    );
    const known = new Set([...imported, ...previouslyChecked, ...queued]);
    job.latestDiagnostics = {
      matching: headIds.length,
      alreadyImported: headIds.filter((id) => imported.has(id)).length,
      alreadyQueued: headIds.filter((id) => queued.has(id)).length,
      alreadyChecked: headIds.filter(
        (id) =>
          previouslyChecked.has(id) && !imported.has(id) && !queued.has(id),
      ).length,
      available: fresh.length,
      hasMoreRecentPages: !!head.nextPageToken,
      recoveredFromRecentAttachments,
    };
    console.info("Gmail latest eligibility check", job.latestDiagnostics);
    if (!job.recentPage) job.recentPage = head.nextPageToken;
    if (fresh.length) {
      job.pending = [...new Set([...fresh, ...job.pending])];
      job.latestPending = [
        ...new Set([...(job.latestPending || []), ...fresh]),
      ];
      job.lastNewEligibleAt = now;
      delete job.backfillPausedReason;
      job.phase = "latest";
      job.message = "Prioritizing newest eligible applications from Gmail…";
    }
    // Once the current mailbox head is known, continue through the remaining
    // recent pages. Append them behind the newest page so freshness still
    // wins, while no labelled email from the last three days is skipped.
    if (!fresh.length && !job.pending.length && job.recentPage) {
      stage = "mailbox-recent-page";
      const page = await gmail<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>(
        token,
        `messages?maxResults=100&q=${encodeURIComponent(recentQuery)}&pageToken=${encodeURIComponent(job.recentPage)}`,
      );
      const recent = (page.messages || [])
        .map((message) => message.id)
        .filter((id) => !known.has(id));
      job.recentPage = page.nextPageToken;
      if (!job.recentPage) delete job.recentPage;
      if (recent.length) {
        job.pending = [...new Set([...job.pending, ...recent])];
        job.latestPending = [
          ...new Set([...(job.latestPending || []), ...recent]),
        ];
        job.lastNewEligibleAt = now;
        delete job.backfillPausedReason;
        job.phase = "latest";
        job.message = "Recovering recent labelled applications from Gmail…";
      }
    }
    job.headCheckedAt = now;
    await checkpoint();
    // History is the final fallback. New mail is checked first on every pass,
    // then the missed three-day window above. Only after six quiet hours do we
    // recover one calendar month at a time, capped at 60 applications for
    // that month before moving to the preceding month.
    if (!job.pending.length && !job.recentPage) {
      const quietUntil =
        (job.lastNewEligibleAt || now) + NEW_INTAKE_QUIET_PERIOD_MS;
      if (now < quietUntil) {
        job.nextBackfillAt = quietUntil;
        job.backfillPausedReason =
          "Historical intake waits while the latest mailbox remains quiet.";
      } else if (job.nextBackfillAt && job.nextBackfillAt > now) {
        job.backfillPausedReason =
          "Waiting six hours after the previous historical batch.";
      } else {
        const storage = await backfillStorageStatus();
        if (storage.blocked) {
          job.backfillPausedReason = storage.percent
            ? `Historical intake paused: Aiven storage is at ${storage.percent}%.`
            : "Historical intake paused until Aiven storage can be verified.";
          job.backfillStoragePercent = storage.percent;
        } else {
          delete job.backfillPausedReason;
          job.backfillStoragePercent = storage.percent;
          const currentMonth = monthKey(new Date(now));
          let targetMonth = job.backfillMonth || previousMonth(currentMonth);
          const advanceMonth = () => {
            job.backfillCompletedMonths = [
              ...new Set([...(job.backfillCompletedMonths || []), targetMonth]),
            ].slice(-48);
            targetMonth = previousMonth(targetMonth);
            job.backfillMonth = targetMonth;
            job.backfillImportedThisMonth = 0;
            delete job.backfillPending;
            delete job.page;
          };
          if ((job.backfillImportedThisMonth || 0) >= BACKFILL_MONTHLY_LIMIT) {
            advanceMonth();
            job.nextBackfillAt = Date.now() + NEW_INTAKE_QUIET_PERIOD_MS;
            job.message = `Historical cap reached for the completed month. Next safe history batch will begin with ${targetMonth}.`;
          } else {
            job.backfillMonth = targetMonth;
            const historyQuery = gmailMonthQuery(query, targetMonth);
            const historyKnown = new Set([
              ...workspace.applications.map((a) => a.gmailMessageId),
              ...(job.seenIds || []),
            ]);
            if (!job.backfillPending?.length && !job.page) {
              stage = "mailbox-history-month";
              const history = await gmail<{
                messages?: { id: string }[];
                nextPageToken?: string;
              }>(
                token,
                `messages?maxResults=100&q=${encodeURIComponent(historyQuery)}`,
              );
              job.backfillPending = (history.messages || [])
                .map((message) => message.id)
                .filter((id) => !historyKnown.has(id));
              job.page = history.nextPageToken;
            } else if (!job.backfillPending?.length && job.page) {
              stage = "mailbox-history-page";
              const page = await gmail<{
                messages?: { id: string }[];
                nextPageToken?: string;
              }>(
                token,
                `messages?maxResults=100&q=${encodeURIComponent(historyQuery)}&pageToken=${encodeURIComponent(job.page)}`,
              );
              job.backfillPending = (page.messages || [])
                .map((message) => message.id)
                .filter((id) => !historyKnown.has(id));
              job.page = page.nextPageToken;
            }
            if (!job.backfillPending?.length && !job.page) {
              advanceMonth();
              job.message = `No unimported applications found for the completed month. Continuing with ${targetMonth}.`;
            } else if (job.backfillPending?.length) {
              const remaining = Math.max(
                0,
                BACKFILL_MONTHLY_LIMIT - (job.backfillImportedThisMonth || 0),
              );
              job.pending = job.backfillPending.slice(
                0,
                Math.min(AUTOMATIC_INTAKE_BATCH_SIZE, remaining),
              );
              job.phase = "backfill";
              job.message = `Importing a safe ${targetMonth} historical email-only batch…`;
            }
          }
        }
      }
      await checkpoint();
    }
    const ids = job.pending.slice(0, AUTOMATIC_INTAKE_BATCH_SIZE);
    if (!ids.length) {
      job.status = "complete";
      job.phase = "idle";
      job.message = "Mailbox checked. No new eligible applications.";
      return job;
    }
    job.status = "processing";
    job.phase = job.latestPending?.includes(ids[0]) ? "latest" : "backfill";
    job.lastBatchPhase = job.phase;
    job.message = `Reading and validating ${ids.length} application${ids.length === 1 ? "" : "s"}…`;
    await checkpoint();
    stage = "message-preview";
    const preview = await previewImport(actor, {
      ids,
      // Leave enough time for the preview, normalized application rows and
      // final job checkpoint to commit to Sheets after document processing.
      // Automated intake intentionally processes a small slice and continues
      // later. Keeping document work below a minute prevents a single complex
      // scan from stranding the whole Gmail queue.
      deadline: now + Math.min(60000, Math.max(1000, budgetMs - 30000)),
      automatic: true,
      emailOnly: job.lastBatchPhase === "backfill",
      requireApplicationEvidence:
        !!job.latestDiagnostics?.recoveredFromRecentAttachments,
    });
    job.checked = preview.scanned;
    job.batchChecked = preview.scanned;
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
    stage = "mailbox-authorization-recheck";
    const currentConnection = await official();
    if (currentConnection.connectedAt !== connection.connectedAt)
      throw new SafeError(
        "Mailbox authorization changed. Retry with the current connection.",
        409,
      );
    if (selections.length) {
      stage = "application-commit";
      const result = await confirmImport(
        actor,
        preview.id,
        selections,
        true,
        true,
        preview.automaticPreview,
      );
      job.imported = result.imported;
      job.batchImported = result.imported;
      // confirmImport resolves only after the application records and their
      // Gmail IDs have committed. The cooldown starts after this point.
      job.databaseState = "saved";
      job.lastDatabaseCommitAt = new Date().toISOString();
    }
    const retryIds = preview.issues.filter((i) =>
      /Failed to retrieve|time limit|Failed to read/.test(i.reason),
    );
    // Failed extraction must remain retryable; keep this bounded batch pending.
    job.failures = retryIds.length ? (job.failures || 0) + 1 : 0;
    const retryBatch = retryIds.length > 0 && job.failures < 3;
    if (!retryIds.length || job.failures >= 3) {
      job.pending = job.pending.slice(ids.length);
      if (job.lastBatchPhase === "backfill") {
        job.backfillPending = job.backfillPending?.filter(
          (id) => !ids.includes(id),
        );
        const monthlyImported =
          (job.backfillImportedThisMonth || 0) + job.imported;
        const finishedMonth =
          job.backfillMonth || previousMonth(monthKey(new Date(now)));
        if (
          monthlyImported >= BACKFILL_MONTHLY_LIMIT ||
          (!job.backfillPending?.length && !job.page)
        ) {
          job.backfillCompletedMonths = [
            ...new Set([...(job.backfillCompletedMonths || []), finishedMonth]),
          ].slice(-48);
          job.backfillMonth = previousMonth(finishedMonth);
          job.backfillImportedThisMonth = 0;
          delete job.backfillPending;
          delete job.page;
        } else {
          job.backfillImportedThisMonth = monthlyImported;
        }
        job.nextBackfillAt = Date.now() + NEW_INTAKE_QUIET_PERIOD_MS;
      } else {
        job.latestPending = job.latestPending?.filter((id) =>
          job.pending.includes(id),
        );
        if (!job.latestPending?.length) delete job.latestPending;
      }
      job.seenIds = [...new Set([...(job.seenIds || []), ...ids])].slice(-5000);
    }
    if (job.failures >= 3) job.failures = 0; // Continue past unreadable mail; issues remain visible and a later scan retries it.
    // Review items describe the current attempted batch. Do not keep a
    // resolved attachment failure visible forever after its email-only
    // fallback was imported successfully; the durable application timeline
    // retains the original processing note for HR review.
    job.issues = preview.issues
      .filter((issue) => !issue.reason.startsWith("Duplicate"))
      .slice(-40);
    job.status = retryBatch ? "error" : "complete";
    const remaining =
      job.pending.length > 0 ||
      !!job.latestPending?.length ||
      !!job.recentPage ||
      !!job.backfillPending?.length ||
      !!job.page;
    if (!retryBatch && remaining) {
      if (job.latestPending?.length || job.recentPage) {
        job.phase = "cooldown";
        job.nextPhase = "latest";
        job.nextSyncAt = Date.now() + INTAKE_COOLDOWN_MS;
        job.message =
          "Waiting briefly so the database can finish the prior save safely.";
      } else {
        job.phase = "idle";
        delete job.nextPhase;
        delete job.nextSyncAt;
        job.message =
          job.backfillPausedReason ||
          "Latest intake remains active; historical intake will wait for its next safe window.";
      }
    } else {
      job.phase = "idle";
      delete job.nextPhase;
      delete job.nextSyncAt;
      job.message = retryBatch
        ? "Some messages could not be read. Retry to resume this batch."
        : retryIds.length
          ? "Unreadable attachments need HR review. Other applications will continue importing automatically."
          : job.imported
            ? `${job.imported} new application${job.imported === 1 ? "" : "s"} imported. Mailbox check complete.`
            : "No new eligible applications in this batch.";
    }
  } catch (error) {
    const e = error as SafeError;
    const errorCode = (error as { code?: unknown } | null)?.code;
    console.error("Gmail intake worker failed", {
      stage,
      type: error instanceof Error ? error.name : typeof error,
      code: typeof errorCode === "string" ? errorCode.slice(0, 32) : undefined,
      status: error instanceof SafeError ? error.status : undefined,
    });
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
      job.nextSyncAt ||
      Date.now() +
        (job.status === "error"
          ? 120000
          : job.status === "capacity"
            ? 30000
            : job.pending.length
              ? INTAKE_COOLDOWN_MS
              : 30000);
    await checkpoint().catch(() => {});
  }
  return job;
}
