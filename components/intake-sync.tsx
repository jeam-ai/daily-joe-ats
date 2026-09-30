"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "@/lib/client-request";
import { canManage } from "@/lib/data-policy";
import type { IntakeSync } from "@/lib/google/gmail/sync";
import { useApp } from "./provider";
import { Button } from "./ui";
import { formatDate } from "@/lib/dates";
export function IntakeSyncStatus() {
  const { state, dataset, refresh } = useApp(),
    [job, setJob] = useState<IntakeSync | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(() => Date.now()),
    lastDatabaseCommit = useRef("");
  const enabled = dataset === "real" && canManage(state?.currentUser);
  const paused = !!state?.intakePaused;
  const working =
    busy || ["checking", "processing"].includes(job?.status || "");
  const coolingDown = !working && !!job?.nextSyncAt && job.nextSyncAt > now;
  const queuedForDatabase = job?.databaseState === "queued";
  const secondsToNext = coolingDown
    ? Math.max(0, Math.ceil((job!.nextSyncAt! - now) / 1000))
    : 0;
  const nextSyncLabel = `${String(Math.floor(secondsToNext / 60)).padStart(2, "0")}:${String(secondsToNext % 60).padStart(2, "0")}`;
  const progress = busy
    ? 10
    : job?.status === "checking"
      ? 30
      : job?.status === "processing"
        ? 70
        : 100;
  const progressLabel = busy
    ? "Starting secure sync"
    : queuedForDatabase
      ? "Waiting for the ATS database to accept the next batch"
      : job?.status === "checking"
        ? "Checking Gmail for eligible applications"
        : "Reading and validating the current application batch";
  const statusLabel = paused
    ? "Paused"
    : error
      ? "Needs attention"
      : queuedForDatabase
        ? "Queued"
        : working
          ? job?.status === "processing"
            ? "Importing"
            : "Checking Gmail"
          : job?.imported
            ? `${job.imported} imported`
            : "Monitoring";
  const historyLabel = job?.backfillPausedReason
    ? "On hold"
    : job?.lastBatchPhase === "backfill"
      ? "Processed"
      : "Standby";
  const historyMonth = job?.backfillMonth
    ? new Intl.DateTimeFormat("en-PH", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${job.backfillMonth}-01T00:00:00Z`))
    : "Standby";
  // Gmail intake remains automatic while HR is using the workspace. A browser
  // profile claims one shared five-minute trigger, so several open tabs do
  // not all start the same expensive Gmail pass.
  const idleStatusDelay = 5 * 60 * 1000;
  const automaticRequestKey = "daily-joe-intake-automatic-requested-at";
  function claimAutomaticRequest() {
    try {
      const lastRequested = Number(
        window.localStorage.getItem(automaticRequestKey) || 0,
      );
      if (
        Number.isFinite(lastRequested) &&
        Date.now() - lastRequested < idleStatusDelay
      )
        return false;
      window.localStorage.setItem(automaticRequestKey, String(Date.now()));
      return true;
    } catch {
      // Storage may be unavailable in a restricted browser. The server still
      // enforces the same cooldown, so a status tab never creates duplicate
      // Gmail work.
      return true;
    }
  }
  async function check() {
    const value = await requestJson<IntakeSync>("/api/intake/sync");
    setJob(value);
    if (
      value.databaseState === "saved" &&
      value.lastDatabaseCommitAt &&
      lastDatabaseCommit.current !== value.lastDatabaseCommitAt
    ) {
      lastDatabaseCommit.current = value.lastDatabaseCommitAt;
      await refresh();
    }
    return value;
  }
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);
  useEffect(() => {
    if (!enabled || paused) return;
    let stopped = false,
      running = false,
      timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (stopped || running) return;
      running = true;
      let delay = idleStatusDelay;
      try {
        const value = await check();
        if (stopped) return;
        const syncDue = !value.retryAt || value.retryAt <= Date.now();
        const mayStartAutomaticSync =
          syncDue &&
          ![
            "checking",
            "processing",
            "authorization",
            "paused",
            "capacity",
          ].includes(value.status);
        if (mayStartAutomaticSync && claimAutomaticRequest()) {
          const result = await requestJson<{ queued: boolean }>(
            "/api/intake/sync/run?automatic=1",
            { method: "POST" },
          );
          if (stopped) return;
          if (result.queued) {
            setJob((current) =>
              current
                ? {
                    ...current,
                    status: "checking",
                    message: "Automatic Gmail check queued…",
                  }
                : current,
            );
            delay = 30000;
          }
        } else {
          delay =
            value.status === "capacity"
              ? idleStatusDelay
              : ["checking", "processing"].includes(value.status)
                ? // The server lease owns the work. Status reads do not need to
                  // poll every few seconds while a document batch is processing.
                  30000
                : value.nextSyncAt && value.nextSyncAt > Date.now()
                  ? Math.max(30000, value.nextSyncAt - Date.now() + 100)
                  : value.nextBackfillAt && value.nextBackfillAt > Date.now()
                    ? idleStatusDelay
                    : idleStatusDelay;
        }
        setError("");
      } catch {
        if (!stopped)
          setError(
            job
              ? "Gmail status could not be refreshed just now. The saved sync will retry safely."
              : "Gmail status is temporarily unavailable. Retry in a moment; no applicant data was changed.",
          );
      } finally {
        running = false;
        if (!stopped) timer = setTimeout(() => void tick(), delay);
      }
    }
    function onVisibilityChange() {
      if (stopped || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      if (!running) void tick();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, paused]);
  if (!enabled) return null;
  return (
    <div className="intake-sync" aria-label="Automatic Gmail intake">
      <div className="intake-summary">
        <div className="intake-heading">
          <div>
            <strong>Gmail intake</strong>
            <span>
              New applications are checked automatically and newest is first.
            </span>
          </div>
          <b
            className={`intake-state ${error ? "attention" : ""}`}
            role="status"
          >
            {statusLabel}
          </b>
        </div>
        <div className="intake-metrics" aria-label="Gmail intake summary">
          <span>
            <b>Latest</b>
            {job?.batchImported || 0} / {job?.batchLimit || 15}
          </span>
          <span>
            <b>History</b>
            {historyLabel === "Processed" ? historyMonth : historyLabel}
          </span>
          <span>
            <b>Month cap</b>
            {job?.backfillImportedThisMonth || 0} / 60
          </span>
          {job?.completedAt && (
            <span>
              <b>Checked</b>
              {formatDate(job.completedAt, state?.preferences, true)}
            </span>
          )}
        </div>
        {(error ||
          job?.backfillPausedReason ||
          coolingDown ||
          queuedForDatabase) && (
          <p className="intake-note" role="status">
            {error ||
              (coolingDown
                ? `Next safe latest sync in ${nextSyncLabel}.`
                : queuedForDatabase
                  ? "Waiting for the prior database save."
                  : job?.backfillPausedReason)}
          </p>
        )}
        {working && (
          <div className="intake-progress-wrap">
            <progress
              max={100}
              value={progress}
              aria-label="Gmail application sync progress"
              aria-valuetext={progressLabel}
            />
          </div>
        )}
        {(job?.issues.length || job?.message || job?.latestDiagnostics) && (
          <details className="intake-details">
            <summary>View intake details</summary>
            <p>{job?.message}</p>
            {job?.latestDiagnostics && (
              <p className="intake-diagnostics">
                {job.latestDiagnostics.recoveredFromRecentAttachments
                  ? "Configured label returned no recent messages; recent resume attachment recovery:"
                  : "Latest labelled scan:"}{" "}
                {job.latestDiagnostics.matching} found ·{" "}
                {job.latestDiagnostics.available} ready ·{" "}
                {job.latestDiagnostics.alreadyImported} already imported ·{" "}
                {job.latestDiagnostics.alreadyQueued} already queued ·{" "}
                {job.latestDiagnostics.alreadyChecked} previously checked
                {job.latestDiagnostics.hasMoreRecentPages
                  ? " · more recent pages will continue safely"
                  : ""}
              </p>
            )}
            {job?.issues.length ? (
              <ul>
                {job.issues.map((issue, i) => (
                  <li key={i}>
                    {issue.message}: {issue.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        )}
      </div>
      <div className="button-row">
        {paused ? (
          <a className="button secondary" href="/settings/preferences">
            Manage intake
          </a>
        ) : job?.status === "authorization" ? (
          <a className="button secondary" href="/settings/integrations">
            Connect Gmail
          </a>
        ) : (
          <>
            {(job?.pending.length || job?.page) && (
              <Button
                variant="ghost"
                disabled={busy || working}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await requestJson<{ job?: IntakeSync }>(
                      "/api/intake/sync/run?reset=1",
                      { method: "POST" },
                    );
                    if (result.job) setJob(result.job);
                    setError("");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Restart queued intake
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={
                busy ||
                coolingDown ||
                (!error &&
                  ["checking", "processing"].includes(job?.status || ""))
              }
              onClick={async () => {
                setBusy(true);
                try {
                  await requestJson("/api/intake/sync/run?force=1", {
                    method: "POST",
                  });
                  setError("");
                  setJob((old) =>
                    old
                      ? {
                          ...old,
                          status: "checking",
                          message: "Sync requested…",
                        }
                      : old,
                  );
                  await check();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={15} />
              {busy
                ? "Starting…"
                : job?.status === "error"
                  ? "Retry sync"
                  : "Sync Now"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
