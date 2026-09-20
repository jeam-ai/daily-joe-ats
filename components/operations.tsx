"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  AuditEvent,
  DiagnosticIssue,
  HealthCheck,
} from "@/types/operations";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingSkeleton,
  Modal,
  Select,
} from "./ui";
const date = (s?: string) =>
  s
    ? new Date(s).toLocaleString("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
const label = (s: string) =>
  s.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
const severityLabel = (s: string) =>
  ({
    Informational: "Info",
    Minor: "Warning",
    "Needs Attention": "Error",
    Critical: "Critical",
  })[s] || s;
const tone = (s: string) =>
  /Critical|Unavailable|Failed|Error/.test(s)
    ? "red"
    : /Healthy|Completed|Resolved|Fixed/.test(s)
      ? "green"
      : /Attention|Recurring|Retrying|Minor/.test(s)
        ? "amber"
        : "neutral";
function useResource<T>(url: string) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function reload() {
    setLoading(true);
    setError("");
    try {
      setData(await requestJson<T>(url));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    requestJson<T>(url, { signal: abort.signal })
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [url]);
  return { data, error, loading, reload, setData };
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <p>{error}</p>
      <Button variant="secondary" onClick={retry}>
        Try Again
      </Button>
    </div>
  );
}
export function SystemHealth() {
  const r = useResource<{ checkedAt?: string; checks: HealthCheck[] }>(
      "/api/system?section=health",
    ),
    { state, notify } = useApp(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    try {
      r.setData(
        await requestJson("/api/system", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check" }),
        }),
      );
      notify("System checks completed. Review each service result.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <Card>
        <div className="card-heading">
          <div>
            <h2>
              <ShieldCheck size={20} /> System Health
            </h2>
            <p>Actual service checks, recorded on request.</p>
          </div>
          <Button
            disabled={busy || state?.currentUser?.role !== "Admin"}
            onClick={check}
          >
            <RefreshCw size={16} />
            {busy ? "Checking services…" : "Check Now"}
          </Button>
        </div>
        <div className="padded">
          <p>Last checked: {date(r.data?.checkedAt)}</p>
          <Link className="text-link" href="/settings/diagnostics">
            Open Error Center
          </Link>
          <p className="fine-print">
            Results are cached. Opening this page does not contact providers or
            analyze applicants. Not Verified means the check could not establish
            a result.
          </p>
          {state?.currentUser?.role !== "Admin" && (
            <p className="fine-print">An administrator can run fresh checks.</p>
          )}
        </div>
      </Card>
      {(r.error || error) && (
        <ErrorState error={r.error || error} retry={r.reload} />
      )}
      {r.loading && !r.data && <LoadingSkeleton />}
      <div className="health-grid">
        {r.data?.checks.map((c) => (
          <Card key={c.id}>
            <div className="card-heading">
              <h3>{c.service}</h3>
              <Badge tone={tone(c.status)}>{c.status}</Badge>
            </div>
            <div className="padded form-stack">
              <p>{c.detail}</p>
              <p className="fine-print">
                Checked: {date(c.checkedAt)}
                <br />
                Last successful check: {date(c.lastSuccess)}
                {c.responseMs !== undefined && (
                  <>
                    <br />
                    Check duration: {c.responseMs} ms
                  </>
                )}
              </p>
              {c.href && (
                <Link className="text-link" href={c.href}>
                  {c.action}
                </Link>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
interface AiIntegrationData {
  configured: boolean;
  provider: string;
  model: string;
  health?: HealthCheck;
  usage: {
    period: string;
    requests: number;
    completed: number;
    failed: number;
    lastSuccess?: string;
    lastError?: { completedAt?: string; errorCode?: string };
  };
}
export function AiIntegration() {
  const r = useResource<AiIntegrationData>("/api/system?section=ai"),
    { state } = useApp(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      await r.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const d = r.data,
    status = !d?.configured
      ? "Not Connected"
      : d.health?.status === "Healthy"
        ? "Connected"
        : d.health?.status === "Attention Needed"
          ? "Error"
          : "Not Verified";
  return (
    <Card>
      <div className="card-heading">
        <div>
          <h2>Gemini provider & AI Assist</h2>
          <p>Optional interpretation with Google Gemini.</p>
        </div>
        <Badge tone={tone(status)}>{status}</Badge>
      </div>
      <div className="padded form-stack">
        {(r.error || error) && (
          <ErrorState error={r.error || error} retry={r.reload} />
        )}{" "}
        {r.loading && !d && <LoadingSkeleton />}
        <div className="form-grid">
          <div>
            <span className="muted">AI provider</span>
            <h3>Gemini</h3>
          </div>
          <div>
            <span className="muted">Configured model</span>
            <p>{d?.model || "Loading…"}</p>
          </div>
          <div>
            <span className="muted">AI Assist</span>
            <p>
              {d?.configured
                ? "Available on request; provider access required"
                : "Unavailable — System Analysis remains available"}
            </p>
          </div>
          <div>
            <span className="muted">Last provider check</span>
            <p>{date(d?.health?.checkedAt)}</p>
          </div>
        </div>
        <p className="info-banner">
          AI Assist runs only when requested. The separate AI Integration
          extraction fallback above can clarify missing or uncertain submitted
          facts after deterministic extraction.
        </p>
        <p>
          The built-in System Analysis remains authoritative. AI Assist cannot
          change qualification results, applicant stages, or hiring decisions.
        </p>
        {d && (
          <div className="form-grid">
            <div>
              <h3>{d.usage.requests}</h3>
              <p>Application requests · {d.usage.period}</p>
            </div>
            <div>
              <h3>
                {d.usage.completed} completed · {d.usage.failed} failed
              </h3>
              <p>Application usage, not provider quota.</p>
            </div>
            <div>
              <p>Last completed: {date(d.usage.lastSuccess)}</p>
              <p>
                Last error:{" "}
                {d.usage.lastError
                  ? `${label(d.usage.lastError.errorCode || "provider")} · ${date(d.usage.lastError.completedAt)}`
                  : "None recorded"}
              </p>
            </div>
          </div>
        )}
        <p className="fine-print">
          Quota details are managed by the AI provider. An administrator
          configures the key and model on the server; keys are never entered or
          displayed here.
        </p>
        <Button
          variant="secondary"
          disabled={busy || state?.currentUser?.role !== "Admin"}
          onClick={check}
        >
          {busy ? "Verifying provider…" : "Check Connection"}
        </Button>
      </div>
    </Card>
  );
}
export function AuditHistory({ applicant }: { applicant?: string }) {
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [page, setPage] = useState(1),
    [search, setSearch] = useState("");
  const query = new URLSearchParams({
    section: "audit",
    page: String(page),
    ...filters,
    ...(applicant ? { applicant } : {}),
  });
  const r = useResource<{ events: AuditEvent[]; total: number; page: number }>(
    "/api/system?" + query.toString(),
  );
  const filter = (key: string, value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };
  return (
    <Card>
      <div className="card-heading">
        <div>
          <h2>
            <Activity size={18} />{" "}
            {applicant ? "Recorded activity" : "Activity History"}
          </h2>
          <p>Server-recorded actions · newest first · append-only</p>
        </div>
        <Button variant="secondary" disabled={r.loading} onClick={r.reload}>
          Refresh
        </Button>
      </div>
      <div className="padded form-stack">
        {!applicant && (
          <>
            <form
              className="button-row"
              onSubmit={(e) => {
                e.preventDefault();
                filter("search", search);
              }}
            >
              <Input
                aria-label="Search audit history"
                placeholder="Applicant, email, event ID or action"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button type="submit">Search</Button>
            </form>
            <div className="audit-filters">
              {[
                ["from", "From"],
                ["to", "To"],
                ["user", "User email"],
                ["action", "Exact action"],
                ["applicant", "Applicant ID"],
              ].map(([key, title]) => (
                <Field key={key} label={title}>
                  <Input
                    type={key === "from" || key === "to" ? "date" : "text"}
                    onBlur={(e) => filter(key, e.target.value)}
                  />
                </Field>
              ))}
              {[
                [
                  "module",
                  [
                    "application",
                    "applicant",
                    "resume",
                    "screening",
                    "ai",
                    "interview",
                    "requirement",
                    "hiring",
                    "settings",
                    "user",
                    "odoo",
                    "timekeeping",
                    "gmail",
                    "sheets",
                    "auth",
                    "demo",
                    "diagnostics",
                    "health",
                  ],
                ],
                [
                  "role",
                  [
                    "Admin",
                    "Talent Acquisition",
                    "HR Generalist",
                    "Office Assistant",
                    "Viewer",
                    "System",
                  ],
                ],
                ["source", ["User", "System"]],
                ["status", ["Completed", "Running", "Failed", "Recorded"]],
                [
                  "entityType",
                  ["Application", "System", "user", "hiring", "timekeeping"],
                ],
              ].map(([key, options]) => (
                <Field key={String(key)} label={label(String(key))}>
                  <Select
                    value={filters[String(key)] || ""}
                    onChange={(e) => filter(String(key), e.target.value)}
                  >
                    <option value="">All</option>
                    {(options as string[]).map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </>
        )}
        {r.error && <ErrorState error={r.error} retry={r.reload} />}{" "}
        {r.loading && !r.data && <LoadingSkeleton />}
        {r.data?.events.length === 0 && (
          <EmptyState
            title="No matching activity"
            description="Recorded actions will appear here. Try adjusting the filters."
          />
        )}
        <ol className="audit-list">
          {r.data?.events.map((e) => (
            <li key={e.id}>
              <div className="section-heading">
                <strong>{label(e.action)}</strong>
                <Badge tone={tone(e.status)}>{e.status}</Badge>
              </div>
              <p>
                {date(e.timestamp)} · {e.actor} · {e.role}
              </p>
              {e.entityId && (
                <p className="fine-print">
                  {e.entityType}: {e.entityId}
                </p>
              )}
              <details>
                <summary>View recorded details</summary>
                <dl>
                  <dt>Event ID</dt>
                  <dd>{e.id}</dd>
                  <dt>Module / source</dt>
                  <dd>
                    {e.module} · {e.source}
                  </dd>
                </dl>
                <pre className="audit-details">
                  {JSON.stringify(e.details, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
        {r.data && (
          <div className="pagination">
            <span>
              {r.data.total} events · Page {page} of{" "}
              {Math.max(1, Math.ceil(r.data.total / 25))}
            </span>
            <div className="button-row">
              <Button
                variant="secondary"
                disabled={page === 1 || r.loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={page * 25 >= r.data.total || r.loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
export function Diagnostics() {
  const r = useResource<{ issues: DiagnosticIssue[] }>(
      "/api/system?section=diagnostics",
    ),
    { state, dataset, setDataset } = useApp(),
    [selected, setSelected] = useState<DiagnosticIssue>(),
    [severity, setSeverity] = useState(""),
    [module, setModule] = useState(""),
    [status, setStatus] = useState("active"),
    [from, setFrom] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const active = (i: DiagnosticIssue) =>
      !["Fixed", "Closed", "Automatically Resolved"].includes(i.status),
    all = r.data?.issues || [],
    open = all.filter(active),
    critical = open.some((i) => i.severity === "Critical");
  const rows = all.filter(
    (i) =>
      (!severity || i.severity === severity) &&
      (!module || i.module === module) &&
      (!from || i.lastAt >= from) &&
      (status === "all" ||
        (status === "active" && active(i)) ||
        (status === "resolved" && !active(i)) ||
        (status === "recurring" && i.occurrences > 1) ||
        (status === "automatic" && i.status === "Automatically Resolved")),
  );
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: selected?.id, note }),
      });
      await r.reload();
      if (action === "close") setSelected(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <Card>
        <div className="card-heading">
          <div>
            <h2>Error Center</h2>
            <p>Detect, explain, and record supported recovery.</p>
          </div>
          <Badge
            tone={
              !r.data
                ? "neutral"
                : critical
                  ? "red"
                  : open.length
                    ? "amber"
                    : "green"
            }
          >
            {!r.data
              ? "Loading recorded issues"
              : critical
                ? "Critical Issue"
                : open.length
                  ? "Issues Detected"
                  : "No active issues recorded"}
          </Badge>
        </div>
        <div className="padded">
          <p>
            {open.length} active · {all.length - open.length} resolved ·{" "}
            {all.filter((i) => i.occurrences > 1).length} recurring
          </p>
          <p className="fine-print">
            Absence of recorded issues does not establish service health.{" "}
            <Link href="/settings/health">View actual health checks</Link>.
          </p>
          {dataset === "demo" && (
            <p className="fine-print">
              Error Center shows actual service issues. Applicant recovery opens
              the real workspace.
            </p>
          )}
        </div>
      </Card>
      {r.error && <ErrorState error={r.error} retry={r.reload} />}
      <Card>
        <div className="padded form-stack">
          <div className="audit-filters">
            <Field label="Severity">
              <Select
                value={severity}
                onChange={(e) => {
                  setSeverity(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All severities</option>
                {["Informational", "Minor", "Needs Attention", "Critical"].map(
                  (s) => (
                    <option key={s} value={s}>
                      {severityLabel(s)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Module">
              <Select
                value={module}
                onChange={(e) => {
                  setModule(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All modules</option>
                {[...new Set(all.map((i) => i.module))].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                {["active", "resolved", "recurring", "automatic", "all"].map(
                  (s) => (
                    <option value={s} key={s}>
                      {label(s)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Detected since">
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
          </div>
          {r.loading && !r.data && <LoadingSkeleton />}
          {!rows.length && !r.loading && (
            <EmptyState
              title="No matching diagnostic issues"
              description="Actual detected failures and recorded resolutions appear here."
            />
          )}
          <div className="audit-list">
            {rows.slice((page - 1) * 20, page * 20).map((i) => (
              <button
                className="diagnostic-row"
                key={i.id}
                onClick={() => {
                  setSelected(i);
                  setNote("");
                  setError("");
                }}
              >
                <div className="section-heading">
                  <strong>{i.title}</strong>
                  <Badge tone={tone(i.severity)}>
                    {severityLabel(i.severity)}
                  </Badge>
                </div>
                <p>
                  {i.module} · {i.status} · {i.occurrences}{" "}
                  {i.occurrences === 1 ? "occurrence" : "occurrences"}
                </p>
                {i.entityId && <small>{i.entityId} · </small>}
                <small>{date(i.lastAt)}</small>
              </button>
            ))}
          </div>
          <div className="pagination">
            <span>{rows.length} issues</span>
            <div className="button-row">
              <Button
                variant="secondary"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={page * 20 >= rows.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </Card>
      {selected && (
        <Modal
          title={selected.title}
          busy={busy}
          onClose={() => setSelected(undefined)}
        >
          <div className="form-stack">
            <Badge tone={tone(selected.severity)}>
              {severityLabel(selected.severity)} · {selected.status}
            </Badge>
            <p>{selected.message}</p>
            <dl>
              <dt>Diagnostic ID</dt>
              <dd>{selected.id}</dd>
              <dt>First detected</dt>
              <dd>{date(selected.firstAt)}</dd>
              <dt>Last detected</dt>
              <dd>{date(selected.lastAt)}</dd>
              <dt>Occurrences / recovery attempts</dt>
              <dd>
                {selected.occurrences} / {selected.recoveryAttempts}
              </dd>
            </dl>
            <div>
              <h3>What is affected?</h3>
              <p>{selected.affected.join(", ")}</p>
              {!!selected.unaffected.length && (
                <>
                  <h3>What remains available?</h3>
                  <p>{selected.unaffected.join(", ")}</p>
                </>
              )}
            </div>
            <p className="fine-print">
              The underlying cause has not been confirmed. Follow the supported
              checks below.
            </p>
            <div>
              <h3>Recommended actions</h3>
              <ol>
                {selected.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
            {selected.entityId && (
              <Link
                className="text-link"
                href={`/applications/${encodeURIComponent(selected.entityId)}`}
                onClick={() => setDataset("real")}
              >
                Open applicant and supported recovery actions
              </Link>
            )}
            {selected.module === "Gmail" && (
              <Link className="text-link" href="/settings/integrations">
                Review / reconnect Gmail
              </Link>
            )}
            {selected.module === "Spreadsheet" && (
              <Link className="text-link" href="/settings/integrations">
                Review spreadsheet synchronization
              </Link>
            )}
            {selected.module === "AI Assist" && (
              <Link className="text-link" href="/settings/ai">
                Review AI Integration
              </Link>
            )}
            {state?.currentUser?.role === "Admin" && (
              <details>
                <summary>Technical Details</summary>
                <dl>
                  <dt>Category</dt>
                  <dd>{selected.category}</dd>
                  <dt>Diagnostic reference</dt>
                  <dd>{selected.id}</dd>
                  <dt>Related job</dt>
                  <dd>{selected.jobId || "Not applicable"}</dd>
                  <dt>Audit event</dt>
                  <dd>{selected.auditId || "Not recorded"}</dd>
                </dl>
                <p className="fine-print">
                  Only sanitized identifiers are retained. No credentials,
                  request headers, document contents, or stack traces are
                  exposed.
                </p>
              </details>
            )}
            {selected.module === "Timekeeping" && (
              <Link className="text-link" href="/timekeeping">
                Open Timekeeping and retry the saved job
              </Link>
            )}
            <h3>Occurrence and recovery history</h3>
            <ol>
              {selected.history.map((h, i) => (
                <li key={i}>
                  {date(h.at)} · {h.action} · {h.actor}
                </li>
              ))}
            </ol>
            {selected.resolution && (
              <p>
                Resolution: {selected.resolution} · {selected.resolvedBy} ·{" "}
                {date(selected.resolvedAt)}
              </p>
            )}
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            {state?.currentUser?.role === "Admin" && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => act("check")}
                >
                  {busy ? "Checking…" : "Retry Diagnostic Check"}
                </Button>
                {active(selected) && (
                  <>
                    <Field label="How did you verify the resolution?">
                      <textarea
                        value={note}
                        maxLength={500}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </Field>
                    <Button
                      disabled={busy || note.trim().length < 10}
                      onClick={() => act("close")}
                    >
                      Mark Resolved / Close Issue
                    </Button>
                    <p className="fine-print">
                      Closing records your verification. It does not perform a
                      repair or change application data.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
