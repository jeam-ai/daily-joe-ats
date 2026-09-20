"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "@/lib/client-request";
import { canManage, activeIntake } from "@/lib/data-policy";
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
  const atCapacity = useRef(false);
  atCapacity.current =
    (state?.applications.filter(activeIntake).length || 0) >= 100;
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
    if (!enabled) return;
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
                ? 8000
                : 60000;
        setError("");
        if (
          !["checking", "processing", "authorization"].includes(value.status) &&
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
  }, [enabled]);
  if (!enabled) return null;
  return (
    <div className="intake-sync" aria-label="Automatic Gmail intake">
      <div>
        <strong>Gmail intake</strong>
        <span role="status">
          {error || job?.message || "Checking sync status…"}
        </span>
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
        {job?.status === "authorization" ? (
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
