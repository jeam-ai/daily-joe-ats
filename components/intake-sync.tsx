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
    last = useRef("");
  const enabled = dataset === "real" && canManage(state?.currentUser);
  const paused = !!state?.intakePaused;
  const working =
    busy || ["checking", "processing"].includes(job?.status || "");
  const progress = busy
    ? 10
    : job?.status === "checking"
      ? 30
      : job?.status === "processing"
        ? 70
        : 100;
  const progressLabel = busy
    ? "Starting secure sync"
    : job?.status === "checking"
      ? "Checking Gmail for eligible applications"
      : "Reading and validating the current application batch";
  async function check() {
    const value = await requestJson<IntakeSync>("/api/intake/sync");
    setJob(value);
    if (value.completedAt && last.current !== value.completedAt) {
      last.current = value.completedAt;
      if (value.imported) await refresh();
    }
    return value;
  }
  useEffect(() => {
    if (!enabled || paused) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function tick() {
      let delay = 60000;
      try {
        const value = await check();
        if (stopped) return;
        delay =
          value.status === "capacity"
            ? 60000
            : ["checking", "processing"].includes(value.status)
              ? 3000
              : value.pending.length || value.page
                ? 4000
                : 120000;
        setError("");
        if (
          !["checking", "processing", "authorization", "paused"].includes(
            value.status,
          ) &&
          (value.consecutiveFailures || 0) < 3 &&
          (!value.retryAt || value.retryAt <= Date.now())
        ) {
          await requestJson("/api/intake/sync", { method: "POST" });
          delay = 1000;
          setJob((old) =>
            old
              ? {
                  ...old,
                  status: "checking",
                  message: "Checking the recruitment inbox…",
                }
              : old,
          );
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), delay);
      }
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, paused]);
  // Automatic evidence fallback is deliberately a separate, slow cadence from
  // Gmail import. It keeps long provider work from delaying intake while still
  // draining eligible low-confidence/missing-field records without HR clicks.
  useEffect(() => {
    if (!enabled || paused) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function pump() {
      try {
        await requestJson("/api/system/extraction?drain=1");
      } catch {
        // The Error Center records server failures. A later cadence retries a
        // safe, leased job without surfacing noisy background toasts.
      } finally {
        // Two leased jobs run after each request. A one-minute cadence keeps
        // backlog moving while respecting provider backoff and never blocks
        // normal workspace navigation.
        if (!stopped) timer = setTimeout(() => void pump(), 60000);
      }
    }
    timer = setTimeout(() => void pump(), 20000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, paused]);
  if (!enabled) return null;
  return (
    <div className="intake-sync" aria-label="Automatic Gmail intake">
      <div>
        <strong>Gmail intake</strong>
        <span role="status">
          {paused
            ? "Paused — applications will not be imported until intake is resumed."
            : error || job?.message || "Checking sync status…"}
        </span>
        {working && (
          <div className="intake-progress-wrap">
            <small>{progressLabel}</small>
            <progress
              max={100}
              value={progress}
              aria-label="Gmail application sync progress"
              aria-valuetext={progressLabel}
            />
          </div>
        )}
        {job?.completedAt && (
          <small>
            Last check: {formatDate(job.completedAt, state?.preferences, true)}
          </small>
        )}
        {job?.issues.length ? (
          <details>
            <summary>{job.issues.length} intake items to review</summary>
            <ul>
              {job.issues.map((issue, i) => (
                <li key={i}>
                  {issue.message}: {issue.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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
          <Button
            variant="secondary"
            disabled={
              busy ||
              (!error && ["checking", "processing"].includes(job?.status || ""))
            }
            onClick={async () => {
              setBusy(true);
              try {
                await requestJson("/api/intake/sync?force=1", {
                  method: "POST",
                });
                setError("");
                setJob((old) =>
                  old
                    ? { ...old, status: "checking", message: "Sync requested…" }
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
        )}
      </div>
    </div>
  );
}
