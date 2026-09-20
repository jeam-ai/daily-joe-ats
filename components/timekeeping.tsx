"use client";
import { useEffect, useMemo, useState } from "react";
import { Download, Upload, Save, ArrowLeft, ChevronRight } from "lucide-react";
import { useApp } from "./provider";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Modal,
} from "./ui";
import { requestJson, downloadFile } from "@/lib/client-request";
import {
  defaultOdooRules,
  reviewStatuses,
  type OdooRules,
  type OdooDay,
  type ReviewStatus,
  type OdooReports,
} from "@/lib/odoo";
import type { TimekeepingJob } from "@/lib/server/timekeeping-jobs";
import type { OdooBatch } from "@/lib/server/odoo";
import { formatDate } from "@/lib/dates";
import { attendanceTimestamp, defaultAttendanceRules } from "@/lib/timekeeping";
type Preview = Pick<
  OdooReports,
  "period" | "sources" | "aliases" | "warnings"
> & {
  id: string;
  attendanceRows: number;
  pivotRows: number;
  employees: number;
};
type BatchIndex = {
  id: string;
  period: OdooReports["period"];
  analyzedAt: string;
};
const hours = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString("en", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const date = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(v + "T12:00:00Z").toLocaleDateString("en", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : v;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const key = (r: OdooDay) => r.employeeId || r.employee;
const clockTime = (
  value: string,
  timezone: OdooRules["timezone"],
  referenceDate: string,
) => {
  if (!value) return "Missing";
  const timestamp = attendanceTimestamp(value, {
    ...defaultAttendanceRules,
    timezone,
    dateOrder: "ISO",
  });
  return timestamp === null
    ? "Needs review"
    : new Date(timestamp).toLocaleString("en", {
        ...(value.slice(0, 10) !== referenceDate
          ? { month: "long" as const, day: "numeric" as const }
          : {}),
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone,
      });
};
export function AttendanceRulesEditor({
  rules,
  onChange,
}: {
  rules: OdooRules;
  onChange: (rules: OdooRules) => void;
}) {
  const set = <K extends keyof OdooRules>(k: K, v: OdooRules[K]) =>
    onChange({ ...rules, [k]: v });
  return (
    <>
      <p className="muted">
        Expected hours come from Pivot. Leave schedule fields empty when working
        times are unknown. Late and early-out results require an HR-confirmed
        schedule shared by these employees.
      </p>
      <div className="form-grid">
        <Field label="Odoo export timezone">
          <Select
            value={rules.timezone}
            onChange={(e) =>
              set("timezone", e.target.value as OdooRules["timezone"])
            }
          >
            {["Asia/Manila", "Asia/Singapore", "UTC"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </Field>
        <Field label="Scheduled start (optional)">
          <Input
            type="time"
            value={rules.start}
            onChange={(e) => set("start", e.target.value)}
          />
        </Field>
        <Field label="Scheduled end (optional)">
          <Input
            type="time"
            value={rules.end}
            onChange={(e) => set("end", e.target.value)}
          />
        </Field>
        {(
          [
            ["graceMinutes", "Late grace (minutes)"],
            ["overtimeMinutes", "Overtime allowance (minutes)"],
            ["discrepancyMinutes", "Reconciliation tolerance (minutes)"],
          ] as const
        ).map(([k, label]) => (
          <Field key={k} label={label}>
            <Input
              type="number"
              min={0}
              max={k === "overtimeMinutes" ? 240 : 120}
              value={rules[k]}
              onChange={(e) => set(k, Number(e.target.value))}
            />
          </Field>
        ))}
        <Field label="System review above total worked hours">
          <Input
            type="number"
            min={1}
            max={24}
            step="0.5"
            value={rules.excessiveWorkedHours ?? 14}
            onChange={(e) =>
              set("excessiveWorkedHours", Number(e.target.value))
            }
          />
          <small>
            Default: more than 14 hours. This flags HR review; it does not
            define payroll entitlement.
          </small>
        </Field>
        <Field label="Fallback expected hours (optional)">
          <Input
            type="number"
            min={0}
            max={24}
            step="0.25"
            placeholder="Use Pivot expected hours"
            value={rules.expectedHours ?? ""}
            onChange={(e) =>
              set(
                "expectedHours",
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
          />
        </Field>
      </div>
      <p className="muted">
        Fallback hours apply only where Pivot expected hours are absent, on
        selected workdays.
      </p>
      <div className="actions">
        {[
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ].map((d, i) => (
          <label key={d} className="checkbox-label">
            <input
              type="checkbox"
              checked={rules.workDays.includes(i)}
              onChange={(e) =>
                set(
                  "workDays",
                  e.target.checked
                    ? [...rules.workDays, i]
                    : rules.workDays.filter((v) => v !== i),
                )
              }
            />
            {d}
          </label>
        ))}
      </div>
    </>
  );
}
export function Timekeeping() {
  const { state, notify, refresh, dataset } = useApp();
  const [attendance, setAttendance] = useState<File | null>(null),
    [pivot, setPivot] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [batch, setBatch] = useState<OdooBatch | null>(null),
    [batches, setBatches] = useState<BatchIndex[]>([]),
    [rules, setRules] = useState(defaultOdooRules),
    [aliases, setAliases] = useState<Record<string, string>>({});
  const [job, setJob] = useState<TimekeepingJob | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [reviewFilter, setReviewFilter] = useState(""),
    [resultFilter, setResultFilter] = useState(""),
    [dayFilter, setDayFilter] = useState(""),
    [department, setDepartment] = useState(""),
    [location, setLocation] = useState(""),
    [page, setPage] = useState(1),
    [employee, setEmployee] = useState(""),
    [detail, setDetail] = useState(""),
    [review, setReview] = useState<ReviewStatus>("For Review"),
    [note, setNote] = useState("");
  const permitted =
    dataset !== "demo" &&
    !!state?.currentUser &&
    ["Admin", "HR Generalist", "Office Assistant"].includes(
      state.currentUser.role,
    );
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      notify(message, "error");
    } finally {
      setBusy("");
    }
  }
  async function watch(initial: TimekeepingJob) {
    let current = initial;
    setJob(current);
    sessionStorage.setItem("djc-timekeeping-job", current.id);
    const until = Date.now() + 180000;
    while (current.status === "Queued" || current.status === "Running") {
      if (Date.now() > until)
        throw Error(
          "Processing is still being checked. Use Check progress to resume; your uploaded reports are saved.",
        );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      current = (
        await requestJson<{ job: TimekeepingJob }>(
          `/api/timekeeping?job=${current.id}`,
        )
      ).job;
      setJob(current);
    }
    if (current.status === "Failed")
      throw Error(current.error || "Processing failed. Retry the saved job.");
    sessionStorage.removeItem("djc-timekeeping-job");
    return current;
  }
  async function load(id: string) {
    const r = await requestJson<{ batch: OdooBatch }>(
      `/api/timekeeping?batch=${encodeURIComponent(id)}`,
    );
    setBatch(r.batch);
    setEmployee("");
    setDetail("");
    setPage(1);
  }
  useEffect(() => {
    if (!permitted) return;
    void run("Loading saved analyses", async () => {
      const r = await requestJson<{
        batches: BatchIndex[];
        template: { rules: OdooRules } | null;
      }>("/api/timekeeping");
      setBatches(r.batches);
      if (r.template) setRules(r.template.rules);
      const id = new URLSearchParams(window.location.search).get("batch");
      if (id) await load(id);
      const savedJob = sessionStorage.getItem("djc-timekeeping-job");
      if (savedJob) {
        const current = (
          await requestJson<{ job: TimekeepingJob }>(
            `/api/timekeeping?job=${savedJob}`,
          )
        ).job;
        const finished = await watch(current);
        if (finished.kind === "upload") setPreview(finished.result as Preview);
        else await load((finished.result as { batchId: string }).batchId);
      }
    });
  }, [permitted]);
  const records = useMemo(() => batch?.records || [], [batch]);
  const filtered = useMemo(
    () =>
      records.filter(
        (r) =>
          (!query || r.employee.toLowerCase().includes(query.toLowerCase())) &&
          (!reviewFilter || r.review.status === reviewFilter) &&
          (!resultFilter || r.results.includes(resultFilter)) &&
          (!dayFilter || r.date === dayFilter) &&
          (!department || r.department === department) &&
          (!location || r.location === location),
      ),
    [
      records,
      query,
      reviewFilter,
      resultFilter,
      dayFilter,
      department,
      location,
    ],
  );
  const employees = useMemo(() => {
    const groups = new Map<string, OdooDay[]>();
    for (const r of filtered)
      groups.set(key(r), [...(groups.get(key(r)) || []), r]);
    return [...groups].sort((a, b) =>
      a[1][0].employee.localeCompare(b[1][0].employee),
    );
  }, [filtered]);
  const pages = Math.max(1, Math.ceil(employees.length / 20)),
    currentPage = Math.min(page, pages),
    selected = records.find((r) => r.id === detail),
    employeeRows = filtered.filter((r) => key(r) === employee);
  const count = (result: string) =>
    records.filter((r) => r.results.includes(result)).length;
  if (dataset === "demo")
    return (
      <EmptyState
        title="Timekeeping is separate from Demo Mode"
        description="Exit Demo to open real attendance files and payroll review. Demo Mode cannot change timekeeping data."
      />
    );
  if (state && !permitted)
    return (
      <EmptyState
        title="Timekeeping access is restricted"
        description="An HR operations role is required to review attendance records."
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">HR OPERATIONS</span>
          <h1>Timekeeping</h1>
          <p>
            Reconcile Odoo attendance and expected hours, then record HR review.
          </p>
        </div>
      </div>
      <p className="fine-print">
        Classifications use uploaded Odoo reports and configured HR rules.
        Review results before payroll or employee action.
      </p>
      {attendance && !pivot && (
        <p className="notice" role="status">
          Attendance uploaded. Add Pivot Worked Hours to continue.
        </p>
      )}
      {pivot && !attendance && (
        <p className="notice" role="status">
          Pivot uploaded. Add Attendance to continue.
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {job && (
        <Card className="padded">
          <div role="status">
            <strong>{job.detail}</strong>
            <p>
              {job.status} · {job.progress}%
            </p>
            <progress
              max={100}
              value={job.progress}
              aria-label="Timekeeping processing progress"
            />
          </div>
          {job.error && <p className="error-banner">{job.error}</p>}
          {job.status !== "Completed" && (
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                void run("Checking saved processing job", async () => {
                  const initial =
                    job.status === "Failed"
                      ? (
                          await requestJson<{ job: TimekeepingJob }>(
                            "/api/timekeeping",
                            json({ action: "retry-job", id: job.id }),
                          )
                        ).job
                      : job;
                  const finished = await watch(initial);
                  if (finished.kind === "upload")
                    setPreview(finished.result as Preview);
                  else
                    await load(
                      (finished.result as { batchId: string }).batchId,
                    );
                })
              }
            >
              {job.status === "Failed" ? "Retry processing" : "Check progress"}
            </Button>
          )}
        </Card>
      )}
      {busy && (
        <p role="status" className="notice">
          {busy}…
        </p>
      )}
      <Card className="padded spaced">
        <details open={!batch}>
          <summary className="odoo-upload-heading">
            Combined Odoo reports
          </summary>
          <p className="muted">
            Upload both original exports for the same cutoff. Source files
            remain unchanged.
          </p>
          <div className="form-grid">
            <Field label="1. Attendance (hr.attendance).xlsx">
              <Input
                type="file"
                accept=".xlsx"
                disabled={!!busy}
                onChange={(e) => {
                  setAttendance(e.target.files?.[0] || null);
                  setPreview(null);
                }}
              />
            </Field>
            <Field label="2. Pivot Worked Hours (hr.attendance).xlsx">
              <Input
                type="file"
                accept=".xlsx"
                disabled={!!busy}
                onChange={(e) => {
                  setPivot(e.target.files?.[0] || null);
                  setPreview(null);
                }}
              />
            </Field>
          </div>
          <Button
            disabled={!attendance || !pivot || !!busy}
            onClick={() =>
              void run("Reading both reports", async () => {
                const form = new FormData();
                form.set("attendance", attendance!);
                form.set("pivot", pivot!);
                const accepted = await requestJson<{ job: TimekeepingJob }>(
                  "/api/timekeeping",
                  { method: "POST", body: form },
                );
                const completed = await watch(accepted.job);
                setPreview(completed.result as Preview);
                setAliases({});
              })
            }
          >
            <Upload size={16} />
            Read reports
          </Button>
          {preview && (
            <div className="odoo-preview">
              <h3>
                {date(preview.period.start)} – {date(preview.period.end)}
              </h3>
              <p>
                {preview.attendanceRows} attendance entries ·{" "}
                {preview.pivotRows} daily Pivot rows · {preview.employees}{" "}
                source employee names
              </p>
              {preview.warnings.map((w) => (
                <p className="muted" key={w}>
                  {w}
                </p>
              ))}
              {preview.aliases.length > 0 && (
                <details>
                  <summary>
                    Confirm employee identities ({preview.aliases.length}{" "}
                    possible matches)
                  </summary>
                  <p>
                    Numbered names stay separate unless you confirm they refer
                    to the same employee. Original names are retained.
                  </p>
                  {preview.aliases.map((a) => (
                    <label className="checkbox-label" key={a.source}>
                      <input
                        type="checkbox"
                        checked={aliases[a.source] === a.candidate}
                        onChange={(e) =>
                          setAliases((prev) => {
                            const next = { ...prev };
                            if (e.target.checked) next[a.source] = a.candidate;
                            else delete next[a.source];
                            return next;
                          })
                        }
                      />
                      Merge {a.source} into {a.candidate}
                    </label>
                  ))}
                </details>
              )}
              <details>
                <summary>Attendance rules and reconciliation tolerance</summary>
                <AttendanceRulesEditor rules={rules} onChange={setRules} />
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void run("Saving attendance rules", async () => {
                      await requestJson(
                        "/api/timekeeping",
                        json({ action: "rules", rules }),
                      );
                      notify("Attendance rules saved.");
                    })
                  }
                >
                  <Save size={16} />
                  Save rules
                </Button>
              </details>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run("Analyzing attendance", async () => {
                    const accepted = await requestJson<{ job: TimekeepingJob }>(
                      "/api/timekeeping",
                      json({
                        action: "analyze",
                        id: preview.id,
                        rules,
                        aliases,
                      }),
                    );
                    const completed = await watch(accepted.job);
                    const r = await requestJson<{
                      batch: OdooBatch & { reused?: boolean };
                    }>(
                      `/api/timekeeping?batch=${(completed.result as { batchId: string }).batchId}`,
                    );
                    setBatch(r.batch);
                    setEmployee("");
                    setDetail("");
                    setPage(1);
                    setBatches(
                      (
                        await requestJson<{ batches: BatchIndex[] }>(
                          "/api/timekeeping",
                        )
                      ).batches,
                    );
                    notify(
                      r.batch.reused
                        ? "Existing analysis restored. Previous reviews preserved."
                        : "Timekeeping analysis complete.",
                    );
                    await refresh();
                  })
                }
              >
                Analyze combined reports
              </Button>
            </div>
          )}
        </details>
      </Card>
      <Card className="padded spaced">
        <Field label="Saved cutoff analysis">
          <Select
            disabled={!!busy}
            value={batch?.id || ""}
            onChange={(e) => {
              if (e.target.value)
                void run("Loading analysis", () => load(e.target.value));
            }}
          >
            <option value="">Choose a saved analysis</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {date(b.period.start)} – {date(b.period.end)} ·{" "}
                {new Date(b.analyzedAt).toLocaleString("en", {
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {!batch && !busy && (
        <EmptyState
          title="Review a complete cutoff"
          description="Upload Attendance and Pivot Worked Hours, or open a saved analysis. HR reviews are retained when the same reports are uploaded again."
        />
      )}
      {batch && (
        <>
          <div className="section-heading">
            <div>
              <h2>
                {date(batch.period.start)} – {date(batch.period.end)}
              </h2>
              <p className="muted">
                {batch.sources.map((s) => s.filename).join(" + ")}
                {batch.previousBatchId
                  ? " · Revised analysis; previous version retained"
                  : ""}
              </p>
            </div>
            <div className="actions">
              {["xlsx", "csv"].map((format) => (
                <Button
                  key={format}
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void run("Preparing export", async () => {
                      await downloadFile(
                        "/api/timekeeping",
                        `Daily-Joe-Careers-Attendance-${batch.period.start}.${format}`,
                        json({ action: "export", id: batch.id, format }),
                      );
                      notify(`${format.toUpperCase()} export downloaded.`);
                    })
                  }
                >
                  <Download size={16} />
                  {format.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
          <div className="odoo-metrics">
            {[
              ["Employees", new Set(records.map(key)).size],
              ["Employee days", records.length],
              ["Late", batch.rules.start ? count("Late") : "—"],
              ["Early out", batch.rules.end ? count("Early Out") : "—"],
              ["Incomplete", count("Incomplete Attendance")],
              ["Undertime", count("Undertime")],
              ["Overtime", count("Overtime")],
              ["Missing time in", count("Missing Time In")],
              ["Missing time out", count("Missing Time Out")],
              ["No attendance", count("No Attendance")],
              ["Multiple entries", count("Multiple Entries")],
              [
                "For review",
                records.filter((r) => r.review.status === "For Review").length,
              ],
              [
                "Resolved / reviewed",
                records.filter((r) => r.review.status !== "For Review").length,
              ],
            ].map(([label, value]) => (
              <Card key={label}>
                <span className="muted">{label}</span>
                <strong>{value}</strong>
              </Card>
            ))}
          </div>
          <details className="card padded spaced">
            <summary>Source reports and rules used</summary>
            <p>
              Uploaded by {batch.uploadedBy} ·{" "}
              {formatDate(batch.uploadedAt, state?.preferences, true)} ·
              Analysis version {batch.version}, revision {batch.revision}
            </p>
            {batch.sources.map((s) => (
              <p key={s.hash}>
                {s.filename} · {s.sheet} · {s.rows} source rows
                <br />
                <small className="source-hash">SHA-256: {s.hash}</small>
              </p>
            ))}
            <p>
              Timezone: {batch.rules.timezone} · Schedule:{" "}
              {batch.rules.start && batch.rules.end
                ? `${batch.rules.start}–${batch.rules.end}`
                : "Not configured"}{" "}
              · Difference tolerance: {batch.rules.discrepancyMinutes} minutes
            </p>
            {batch.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            {Object.entries(batch.aliases).map(([a, b]) => (
              <p key={a}>
                Confirmed identity: {a} → {b}
              </p>
            ))}
          </details>
          <Card className="padded spaced">
            <div className="odoo-filters">
              <Field label="Employee">
                <Input
                  placeholder="Search employees"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={dayFilter}
                  min={batch.period.start}
                  max={batch.period.end}
                  onChange={(e) => setDayFilter(e.target.value)}
                />
              </Field>
              <Field label="Calculated result">
                <Select
                  value={resultFilter}
                  onChange={(e) => setResultFilter(e.target.value)}
                >
                  <option value="">All results</option>
                  {[...new Set(records.flatMap((r) => r.results))]
                    .sort()
                    .map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                </Select>
              </Field>
              <Field label="HR review status">
                <Select
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value)}
                >
                  <option value="">All reviews</option>
                  {reviewStatuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
              {(
                [
                  ["Department", department, setDepartment, "department"],
                  ["Location", location, setLocation, "location"],
                ] as const
              ).map(([label, value, set, k]) => (
                <Field label={label} key={label}>
                  <Select
                    value={value}
                    disabled={!records.some((r) => r[k])}
                    onChange={(e) => set(e.target.value)}
                  >
                    <option value="">
                      {records.some((r) => r[k])
                        ? `All ${label.toLowerCase()}s`
                        : "Not supplied by Odoo"}
                    </option>
                    {[...new Set(records.map((r) => r[k]).filter(Boolean))].map(
                      (s) => (
                        <option key={s}>{s}</option>
                      ),
                    )}
                  </Select>
                </Field>
              ))}
            </div>
            {employee ? (
              <>
                <Button variant="ghost" onClick={() => setEmployee("")}>
                  <ArrowLeft size={16} />
                  All employees
                </Button>
                <h3>{employeeRows[0]?.employee || employee}</h3>
                <p className="muted">
                  {date(batch.period.start)} – {date(batch.period.end)} ·{" "}
                  {batch.rules.timezone}
                </p>
                <Table>
                  <thead>
                    <tr>
                      {[
                        "Date",
                        "Time in / out",
                        "Worked / expected",
                        "Calculated result",
                        "HR review",
                        "Details",
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {employeeRows.map((r) => (
                      <tr key={r.id}>
                        <td>{date(r.date)}</td>
                        <td>
                          {r.raw.length
                            ? r.raw.map((entry) => (
                                <div className="clock-entry" key={entry.row}>
                                  <span>
                                    {clockTime(
                                      entry.checkIn,
                                      batch.rules.timezone,
                                      r.date,
                                    )}
                                  </span>
                                  {" → "}
                                  <span>
                                    {clockTime(
                                      entry.checkOut,
                                      batch.rules.timezone,
                                      r.date,
                                    )}
                                  </span>
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td>
                          {hours(r.worked)} / {hours(r.expected)} h
                        </td>
                        <td>
                          <div className="actions">
                            {r.results.map((s) => (
                              <button
                                className="issue-button"
                                key={s}
                                onClick={() => {
                                  setDetail(r.id);
                                  setReview(r.review.status);
                                  setNote(r.review.note);
                                }}
                              >
                                <Badge
                                  tone={
                                    s === "Normal" || s === "Rest Day / Day Off"
                                      ? "green"
                                      : "amber"
                                  }
                                >
                                  {s}
                                </Badge>
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <Badge
                            tone={
                              r.review.status === "For Review"
                                ? "orange"
                                : "green"
                            }
                          >
                            {r.review.status}
                          </Badge>
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setDetail(r.id);
                              setReview(r.review.status);
                              setNote(r.review.note);
                            }}
                          >
                            Review <ChevronRight size={15} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      {[
                        "Employee",
                        "Days",
                        "Worked hours",
                        "Expected hours",
                        "For review",
                        "Details",
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {employees
                      .slice((currentPage - 1) * 20, currentPage * 20)
                      .map(([id, rows]) => (
                        <tr key={id}>
                          <td>
                            <strong>{rows[0].employee}</strong>
                            <small className="muted">
                              {rows[0].employeeId || "Matched by source name"}
                            </small>
                          </td>
                          <td>{rows.length}</td>
                          <td>
                            {hours(
                              rows.reduce((sum, r) => sum + (r.worked ?? 0), 0),
                            )}
                          </td>
                          <td>
                            {rows.some((r) => r.expected !== null)
                              ? hours(
                                  rows.reduce(
                                    (sum, r) => sum + (r.expected ?? 0),
                                    0,
                                  ),
                                )
                              : "—"}
                            {rows.some((r) => r.expected === null) && (
                              <small className="muted">
                                {rows.filter((r) => r.expected === null).length}{" "}
                                dates unavailable
                              </small>
                            )}
                          </td>
                          <td>
                            <Badge
                              tone={
                                rows.some(
                                  (r) => r.review.status === "For Review",
                                )
                                  ? "orange"
                                  : "green"
                              }
                            >
                              {
                                rows.filter(
                                  (r) => r.review.status === "For Review",
                                ).length
                              }
                            </Badge>
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => setEmployee(id)}
                            >
                              View days <ChevronRight size={15} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </Table>
                {!employees.length && (
                  <EmptyState
                    title="No matching attendance"
                    description="Adjust the employee, date or status filters."
                  />
                )}
                <div className="pagination">
                  <span>
                    {employees.length} employees · Page {currentPage} of {pages}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={currentPage >= pages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </Card>
        </>
      )}
      {selected && batch && (
        <Modal
          title={`${selected.employee} · ${date(selected.date)}`}
          busy={!!busy}
          onClose={() => setDetail("")}
        >
          <p className="muted">
            Calculated result and HR review are recorded separately. Source
            attendance is never changed.
          </p>
          <div className="actions">
            {selected.results.map((s) => (
              <Badge key={s} tone="amber">
                {s}
              </Badge>
            ))}
          </div>
          <div className="odoo-comparison">
            {(
              [
                ["Attendance worked", selected.rawWorked],
                ["Pivot worked", selected.pivotWorked],
                ["Expected", selected.expected],
                ["Calculated difference", selected.difference],
                ["Pivot difference", selected.pivotDifference],
                ["Balance", selected.balance],
                ["Over Time (source)", selected.overtime],
                ["Extra Hours (source)", selected.extra],
              ] as const
            ).map(([label, v]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{hours(v)} h</strong>
              </div>
            ))}
          </div>
          {selected.issues.length > 0 && (
            <ul>
              {selected.issues.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <details open>
            <summary>Attendance source records ({selected.raw.length})</summary>
            {selected.raw.length ? (
              <Table>
                <thead>
                  <tr>
                    <th>Row / source name</th>
                    <th>Check In</th>
                    <th>Check Out</th>
                    <th>Worked</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.raw.map((r) => (
                    <tr key={r.row}>
                      <td>
                        {r.row} · {r.employee}
                      </td>
                      <td>{r.checkIn || "Missing"}</td>
                      <td>{r.checkOut || "Missing"}</td>
                      <td>{hours(r.worked)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p>No raw Attendance entry for this employee/date.</p>
            )}
          </details>
          <details>
            <summary>Pivot source records ({selected.pivot.length})</summary>
            {selected.pivot.map((r) => (
              <p key={r.row}>
                Row {r.row} · {r.employee} · {r.date}
                <br />
                Worked {hours(r.worked)} · Expected {hours(r.expected)} ·
                Difference {hours(r.difference)} · Balance {hours(r.balance)}
              </p>
            ))}
          </details>
          <Field label="HR review status">
            <Select
              value={review}
              onChange={(e) => setReview(e.target.value as ReviewStatus)}
            >
              {reviewStatuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Resolution / verification note">
            <textarea
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Record the evidence and reason for this review."
            />
          </Field>
          <Button
            disabled={!!busy || (!note.trim() && review !== "For Review")}
            onClick={() =>
              void run("Saving review", async () => {
                const r = await requestJson<{ batch: OdooBatch }>(
                  "/api/timekeeping",
                  json({
                    action: "review",
                    id: batch.id,
                    revision: batch.revision,
                    recordId: selected.id,
                    status: review,
                    note,
                  }),
                );
                setBatch(r.batch);
                notify("Attendance review saved.");
                setDetail("");
              })
            }
          >
            <Save size={16} />
            Save review
          </Button>
          <details>
            <summary>Review history ({selected.review.history.length})</summary>
            {selected.review.history.length ? (
              selected.review.history.map((h, i) => (
                <p key={i}>
                  {h.previous} → {h.next}
                  <br />
                  {h.reviewer} ·{" "}
                  {formatDate(h.timestamp, state?.preferences, true)}
                  <br />
                  {h.note}
                </p>
              ))
            ) : (
              <p>No HR review has been recorded.</p>
            )}
          </details>
        </Modal>
      )}
    </>
  );
}
