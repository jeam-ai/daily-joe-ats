"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Download,
  Upload,
  Save,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Trash2,
} from "lucide-react";
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
  HelpTip,
} from "./ui";
import { RichTextContent, RichTextEditor } from "./rich-text";
import { BulkActions } from "./bulk-actions";
import {
  attendanceSeverities,
  attendanceSeverity,
  matchesAttendance,
  type AttendanceFilters,
} from "@/lib/attendance-automation";
import { requestJson, downloadFile, RequestError } from "@/lib/client-request";
import {
  defaultOdooRules,
  isZeroExpectedHoursSystemIssue,
  reviewStatuses,
  type OdooRules,
  type OdooDay,
  type ReviewStatus,
  type AttendanceClassification,
  type OdooReports,
} from "@/lib/odoo";
import type { TimekeepingJob } from "@/lib/server/timekeeping-jobs";
import type { OdooBatch } from "@/lib/server/odoo";
import { formatDate } from "@/lib/dates";
import { attendanceTimestamp, defaultAttendanceRules } from "@/lib/timekeeping";
import {
  defaultTimekeepingCutoffGraceDays,
  timekeepingRetentionLabel,
} from "@/lib/timekeeping-retention";
import {
  cutoffWorkflow,
  employeeAttendanceSummary,
  isNormalOvertimeForSeparateMonitoring,
  issueExplanation,
  queueGroupFilter,
  needsAction,
  awaitsVerification,
  mergeAttendanceReview,
} from "@/lib/timekeeping-workflow";
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
  savedAt?: string;
  retentionExpiresAt?: string;
};
type ReviewUpdate = Pick<OdooBatch, "id" | "revision" | "records">;
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
const classificationsFor = (record: OdooDay): AttendanceClassification[] =>
  record.results.includes("Negative Attendance")
    ? ["Late", "Undertime", "Early Out"]
    : record.results.includes("No Attendance") ||
        record.results.includes("Leave")
      ? ["Day Off", "Leave", "Absent", "System / Data Issue", "Other"]
      : [];
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
function SeverityBadge({
  record,
  severity,
}: {
  record?: OdooDay;
  severity?: string;
}) {
  const value = severity || (record ? attendanceSeverity(record) : "Low");
  return (
    <Badge
      tone={
        value === "Critical"
          ? "red"
          : value === "High"
            ? "orange"
            : value === "Medium"
              ? "amber"
              : "green"
      }
    >
      {value}
    </Badge>
  );
}
function AttendanceCalculation({ record }: { record: OdooDay }) {
  return (
    <div className="attendance-calculation">
      {record.calculation?.notes.map((note) => (
        <small className="cell-secondary" key={note}>
          {note}
        </small>
      ))}
    </div>
  );
}
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
        <Field label="Overtime credit">
          <Select
            value={rules.overtimeRounding || "nearest"}
            onChange={(e) =>
              set("overtimeRounding", e.target.value as "nearest" | "completed")
            }
          >
            <option value="nearest">Nearest whole hour (9h31 → 1h)</option>
            <option value="completed">Completed whole hours</option>
          </Select>
          <small>
            8h–9h30 is normal. Exact minutes remain in every record.
          </small>
        </Field>
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
            ["discrepancyMinutes", "Reconciliation tolerance (minutes)"],
          ] as const
        ).map(([k, label]) => (
          <Field key={k} label={label}>
            <Input
              type="number"
              min={0}
              max={120}
              value={rules[k]}
              onChange={(e) => set(k, Number(e.target.value))}
            />
          </Field>
        ))}
        <Field label="Excessive overtime threshold (worked hours)">
          <Input
            type="number"
            min={9}
            max={24}
            step="0.5"
            value={rules.excessiveWorkedHours ?? 16}
            onChange={(e) =>
              set("excessiveWorkedHours", Number(e.target.value))
            }
          />
          <small>
            Overtime starts at 9h31 attendance; excessive overtime defaults to
            16 hours or more. This flags an HR review and possible forgotten
            time-out; it does not define payroll entitlement.
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
    [cutoff, setCutoff] = useState({ start: "", end: "" }),
    [batch, setBatch] = useState<OdooBatch | null>(null),
    [batches, setBatches] = useState<BatchIndex[]>([]),
    [rules, setRules] = useState(defaultOdooRules),
    [aliases, setAliases] = useState<Record<string, string>>({});
  const [job, setJob] = useState<TimekeepingJob | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [reviewFilter, setReviewFilter] = useState("For Review"),
    [reviewedOnly, setReviewedOnly] = useState(false),
    [resultFilter, setResultFilter] = useState(""),
    [dayFilter, setDayFilter] = useState(""),
    [department, setDepartment] = useState(""),
    [location, setLocation] = useState(""),
    [page, setPage] = useState(1),
    [employee, setEmployee] = useState(""),
    [detail, setDetail] = useState(""),
    [review, setReview] = useState<ReviewStatus>("For Review"),
    [note, setNote] = useState(""),
    [classification, setClassification] = useState<
      AttendanceClassification | ""
    >("");
  const [pendingClassification, setPendingClassification] = useState<
    AttendanceClassification | ""
  >("");
  const [correctedInOdoo, setCorrectedInOdoo] = useState(false),
    [retainedSourceRows, setRetainedSourceRows] = useState<number[]>([]),
    [reviewNext, setReviewNext] = useState(false),
    [selectedOvertimeIds, setSelectedOvertimeIds] = useState<string[]>([]),
    [confirmOvertimeCompletion, setConfirmOvertimeCompletion] = useState(false),
    [overtimeCompletionNote, setOvertimeCompletionNote] = useState("");
  const [overtimeScope, setOvertimeScope] = useState<"employee" | "cutoff">(
    "employee",
  );
  const [confirmDeleteCutoff, setConfirmDeleteCutoff] = useState(false);
  const [confirmSystemErrors, setConfirmSystemErrors] = useState(false);
  const [systemErrorNote, setSystemErrorNote] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [scheduleFilter, setScheduleFilter] = useState("");
  const [globalIds, setGlobalIds] = useState<string[]>([]);
  const [bulkOperation, setBulkOperation] = useState("");
  const [globalReason, setGlobalReason] = useState("");
  const [globalNote, setGlobalNote] = useState("");
  const [bulkRows, setBulkRows] = useState<OdooDay[]>([]);
  const [bulkNote, setBulkNote] = useState("");
  const [bulkDecisions, setBulkDecisions] = useState<
    Record<
      string,
      {
        classification: AttendanceClassification | "";
        retainedSourceRows: number[];
      }
    >
  >({});
  function openBulkReview(rows: OdooDay[]) {
    setBulkRows(rows);
    setBulkNote("");
    setBulkDecisions(
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            classification: row.review.classification || "",
            retainedSourceRows: row.raw.map((source) => source.row),
          },
        ]),
      ),
    );
  }
  function openRecord(record: OdooDay) {
    setDetail(record.id);
    setReview(record.review.status);
    setNote(record.review.note);
    setClassification(record.review.classification || "");
    setCorrectedInOdoo(!!record.review.correctedInOdoo);
    setRetainedSourceRows(
      record.review.duplicateResolution?.retainedSourceRows ||
        record.raw.map((source) => source.row),
    );
    setPendingClassification("");
  }
  function applySavedReview(update: ReviewUpdate) {
    setBatch((current) =>
      current ? mergeAttendanceReview(current, update) : current,
    );
  }
  function beginClassification(
    record: OdooDay,
    choice: AttendanceClassification,
  ) {
    openRecord(record);
    setPendingClassification(choice);
  }
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
      if (
        batch &&
        [
          "Saving review",
          "Resolving employee attendance",
          "Completing normal overtime",
          "Resolving zero expected hours",
          "Saving bulk attendance review",
        ].includes(label) &&
        e instanceof RequestError &&
        [0, 408, 409].includes(e.status)
      ) {
        try {
          const latest = await requestJson<{ batch: OdooBatch }>(
            `/api/timekeeping?batch=${encodeURIComponent(batch.id)}`,
          );
          setBatch((current) =>
            current?.id === latest.batch.id ? latest.batch : current,
          );
          if (latest.batch.revision > batch.revision && e.status !== 409) {
            setDetail("");
            setBulkRows([]);
            setConfirmSystemErrors(false);
            setConfirmOvertimeCompletion(false);
            notify(
              "Latest saved attendance statuses loaded automatically. Check the records before retrying.",
            );
            return;
          }
        } catch {
          // Preserve the original save error if its verification read also fails.
        }
      }
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
    let interruptions = 0;
    while (current.status === "Queued" || current.status === "Running") {
      if (Date.now() > until)
        throw Error(
          "Processing is still being checked. Use Check progress to resume; your uploaded reports are saved.",
        );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        current = (
          await requestJson<{ job: TimekeepingJob }>(
            `/api/timekeeping?job=${current.id}`,
          )
        ).job;
        interruptions = 0;
      } catch (error) {
        if (
          !(error instanceof RequestError) ||
          ![0, 408, 503, 504].includes(error.status) ||
          ++interruptions > 3
        )
          throw error;
        setJob({
          ...current,
          detail: "Connection interrupted. Checking saved progress…",
        });
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** interruptions),
        );
        continue;
      }
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
    setSelectedOvertimeIds([]);
  }
  function showPreview(value: Preview) {
    setPreview(value);
    setCutoff({ start: value.period.start, end: value.period.end });
  }
  useEffect(() => {
    if (!permitted) return;
    void run("Loading saved analyses", async () => {
      const r = await requestJson<{
        batches: BatchIndex[];
        template: { rules: OdooRules } | null;
      }>("/api/timekeeping");
      setBatches(r.batches);
      if (r.template)
        setRules({
          ...r.template.rules,
          excessiveWorkedHours:
            r.template.rules.excessiveWorkedHours === 14
              ? 16
              : (r.template.rules.excessiveWorkedHours ?? 16),
        });
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
        if (finished.kind === "upload") showPreview(finished.result as Preview);
        else await load((finished.result as { batchId: string }).batchId);
      }
    });
  }, [permitted]);
  const records = useMemo(() => batch?.records || [], [batch]);
  const filtered = useMemo(
    () =>
      records.filter(
        (r) =>
          matchesAttendance(r, {
            query,
            status: reviewFilter,
            result: resultFilter,
            date: dayFilter,
            department,
            location,
            severity: severityFilter,
            schedule: scheduleFilter,
          }) &&
          (!reviewedOnly || r.review.status !== "For Review"),
      ),
    [
      records,
      query,
      reviewFilter,
      reviewedOnly,
      resultFilter,
      dayFilter,
      department,
      location,
      severityFilter,
      scheduleFilter,
    ],
  );
  const employees = useMemo(() => {
    const groups = new Map<string, OdooDay[]>();
    for (const r of filtered)
      groups.set(key(r), [...(groups.get(key(r)) || []), r]);
    const rank = (rows: OdooDay[]) =>
      Math.min(
        ...rows.map((r) => attendanceSeverities.indexOf(attendanceSeverity(r))),
      );
    return [...groups].sort(
      (a, b) =>
        rank(a[1]) - rank(b[1]) ||
        a[1][0].employee.localeCompare(b[1][0].employee),
    );
  }, [filtered]);
  const pages = Math.max(1, Math.ceil(employees.length / 20)),
    currentPage = Math.min(page, pages),
    selected = records.find((r) => r.id === detail),
    employeeRows = filtered.filter((r) => key(r) === employee);
  const count = (result: string) =>
    records.filter((r) => r.results.includes(result)).length;
  const reviewCount = records.filter(
    (record) => record.review.status === "For Review",
  ).length;
  const resolvedCount = records.length - reviewCount;
  const workflow = useMemo(() => cutoffWorkflow(records), [records]);
  const allEmployeeRows = useMemo(() => {
    const groups = new Map<string, OdooDay[]>();
    for (const record of records)
      groups.set(key(record), [...(groups.get(key(record)) || []), record]);
    return groups;
  }, [records]);
  const employeePendingRows = employeeRows.filter(
    (row) => needsAction(row) || awaitsVerification(row),
  );
  const employeeIndex = employees.findIndex(([id]) => id === employee);
  const detailEmployeeIndex = employees.findIndex(
    ([id]) => selected && id === key(selected),
  );
  function moveEmployee(offset: number, inDetail = false) {
    const target =
      employees[(inDetail ? detailEmployeeIndex : employeeIndex) + offset];
    if (!target) return;
    setEmployee(target[0]);
    setGlobalIds([]);
    setSelectedOvertimeIds([]);
    if (inDetail) openRecord(target[1].find(needsAction) || target[1][0]);
  }
  const selectedNormalOvertime = employeeRows.filter(
    (record) =>
      selectedOvertimeIds.includes(record.id) &&
      isNormalOvertimeForSeparateMonitoring(record),
  );
  const bulkFilters: AttendanceFilters = {
    query,
    status: reviewFilter,
    result: resultFilter,
    date: dayFilter,
    department,
    location,
    severity: severityFilter,
    schedule: scheduleFilter,
    employee,
  };
  const selectableRows = filtered.filter(
    (r) => !employee || key(r) === employee,
  );
  const selectedGlobalRows = selectableRows.filter((r) =>
    globalIds.includes(r.id),
  );
  const allGlobalSelected =
    selectableRows.length > 0 &&
    selectedGlobalRows.length === selectableRows.length;
  useEffect(() => {
    setGlobalIds([]);
    setPage(1);
  }, [
    batch?.id,
    query,
    reviewFilter,
    resultFilter,
    dayFilter,
    department,
    location,
    severityFilter,
    scheduleFilter,
    employee,
    reviewedOnly,
  ]);
  const normalOvertimeRows = employeeRows.filter(
    isNormalOvertimeForSeparateMonitoring,
  );
  const cutoffOvertimeRows = records.filter(
    isNormalOvertimeForSeparateMonitoring,
  );
  const zeroExpectedRows = records.filter(
    (row) =>
      row.review.status === "For Review" && isZeroExpectedHoursSystemIssue(row),
  );
  const completionRows =
    overtimeScope === "cutoff" ? cutoffOvertimeRows : selectedNormalOvertime;
  const completionEmployees = new Set(completionRows.map(key)).size;
  const allNormalOvertimeSelected =
    normalOvertimeRows.length > 0 &&
    normalOvertimeRows.every((record) =>
      selectedOvertimeIds.includes(record.id),
    );
  function toggleAllNormalOvertime() {
    const visibleIds = new Set(normalOvertimeRows.map((record) => record.id));
    setSelectedOvertimeIds((current) =>
      allNormalOvertimeSelected
        ? current.filter((id) => !visibleIds.has(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }
  const openQueueRecord = (record: OdooDay) => {
    setReviewNext(true);
    openRecord(record);
  };
  const openQueueGroup = (result: string) => {
    setEmployee("");
    setPage(1);
    setReviewFilter("For Review");
    setReviewedOnly(false);
    setResultFilter(result);
  };
  const activeDashboardMetric = reviewFilter
    ? reviewFilter === "For Review"
      ? "review"
      : ""
    : reviewedOnly
      ? "resolved"
      : resultFilter;
  function filterMetric(filter: string) {
    setEmployee("");
    setPage(1);
    setResultFilter(filter === "review" || filter === "resolved" ? "" : filter);
    setReviewedOnly(filter === "resolved");
    setReviewFilter(filter === "review" ? "For Review" : "");
  }
  const hasReviewFilters = Boolean(
    query ||
    reviewFilter ||
    reviewedOnly ||
    resultFilter ||
    dayFilter ||
    department ||
    location ||
    severityFilter ||
    scheduleFilter,
  );
  function clearReviewFilters() {
    setQuery("");
    setReviewFilter("");
    setReviewedOnly(false);
    setResultFilter("");
    setDayFilter("");
    setDepartment("");
    setLocation("");
    setSeverityFilter("");
    setScheduleFilter("");
    setPage(1);
  }
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
    <div className="workspace-page timekeeping-page">
      <div className="page-heading workspace-page-heading timekeeping-page-heading">
        <div>
          <span className="eyebrow">HR OPERATIONS</span>
          <h1>Timekeeping</h1>
          <p>
            Reconcile Odoo attendance and expected hours, then record HR review.
          </p>
        </div>
        <div
          className="workspace-heading-context timekeeping-page-status"
          aria-label="Timekeeping scope"
        >
          <Badge>Odoo source data</Badge>
          <span>Review &amp; resolution workspace</span>
        </div>
      </div>
      <p className="timekeeping-page-note">
        The hub analyzes imported Odoo reports; HR confirms classifications and
        records any correction separately before payroll action.
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
        <Card className="padded timekeeping-job-card">
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
                    showPreview(finished.result as Preview);
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
      <div className="timekeeping-setup-grid">
        <Card className="padded spaced timekeeping-import-card">
          <details open={!batch} className="timekeeping-upload-disclosure">
            <summary className="odoo-upload-heading">
              Combined Odoo reports
            </summary>
            <p className="muted timekeeping-import-copy">
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
              className="timekeeping-read-reports"
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
                  showPreview(completed.result as Preview);
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
                <p className="muted">
                  Confirm the payroll cutoff dates. The report dates shown above
                  are inferred from entries and may omit days with no records.
                </p>
                <div className="form-grid">
                  <Field label="Cutoff start">
                    <Input
                      type="date"
                      value={cutoff.start}
                      onChange={(e) =>
                        setCutoff((current) => ({
                          ...current,
                          start: e.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Cutoff end">
                    <Input
                      type="date"
                      value={cutoff.end}
                      onChange={(e) =>
                        setCutoff((current) => ({
                          ...current,
                          end: e.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
                <p className="muted">
                  Reprocessing this cutoff replaces the calculated analysis
                  while preserving matching HR classifications and review
                  history.
                </p>
                {preview.aliases.length > 0 && (
                  <details className="timekeeping-disclosure">
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
                              if (e.target.checked)
                                next[a.source] = a.candidate;
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
                <details className="timekeeping-disclosure">
                  <summary>
                    Attendance rules and reconciliation tolerance
                  </summary>
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
                      const accepted = await requestJson<{
                        job: TimekeepingJob;
                      }>(
                        "/api/timekeeping",
                        json({
                          action: "analyze",
                          id: preview.id,
                          rules,
                          aliases,
                          cutoff,
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
        <Card className="padded spaced timekeeping-cutoff-card">
          <span className="eyebrow">CUTOFF HISTORY</span>
          <h2>Resume a saved cutoff</h2>
          <p className="muted">
            Continue an unfinished cutoff another day without uploading the Odoo
            exports again.
          </p>
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
                  {new Date(b.savedAt || b.analyzedAt).toLocaleString("en", {
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </option>
              ))}
            </Select>
          </Field>
          <small>
            Existing HR classifications and correction history stay attached to
            the cutoff.
          </small>
        </Card>
      </div>
      {!batch && !busy && (
        <EmptyState
          title="Review a complete cutoff"
          description="Upload Attendance and Pivot Worked Hours, or open a saved analysis. HR reviews are retained when the same reports are uploaded again."
        />
      )}
      {batch && (
        <>
          <div className="section-heading timekeeping-cutoff-heading">
            <div>
              <span className="eyebrow">Current cutoff</span>
              <h2>
                {date(batch.period.start)} – {date(batch.period.end)}
              </h2>
              <p className="muted">
                {batch.sources.map((s) => s.filename).join(" + ")}
                {batch.previousBatchId
                  ? " · Revised analysis; previous saved version replaced"
                  : ""}
              </p>
              <p className="timekeeping-checkpoint-note">
                Saved{" "}
                {formatDate(
                  batch.savedAt || batch.analyzedAt,
                  state?.preferences,
                  true,
                )}
                {batch.retentionExpiresAt
                  ? ` · Cutoff data is permanently deleted after ${formatDate(batch.retentionExpiresAt, state?.preferences)}`
                  : ` · ${timekeepingRetentionLabel(defaultTimekeepingCutoffGraceDays)}`}
              </p>
            </div>
            <div className="actions">
              <Badge tone={reviewCount ? "orange" : "green"}>
                {reviewCount ? `${reviewCount} for review` : "Review complete"}
              </Badge>
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={() =>
                  void run("Saving cutoff checkpoint", async () => {
                    const saved = await requestJson<{ batch: OdooBatch }>(
                      "/api/timekeeping",
                      json({
                        action: "checkpoint",
                        id: batch.id,
                        revision: batch.revision,
                      }),
                    );
                    setBatch(saved.batch);
                    setBatches((current) =>
                      current.map((index) =>
                        index.id === saved.batch.id
                          ? {
                              ...index,
                              savedAt: saved.batch.savedAt,
                              retentionExpiresAt:
                                saved.batch.retentionExpiresAt,
                            }
                          : index,
                      ),
                    );
                    notify(
                      "Cutoff checkpoint saved. You can resume it from Saved cutoffs anytime before its retention deadline.",
                    );
                  })
                }
              >
                <Save size={16} />
                Save checkpoint
              </Button>
              <Button
                variant="danger"
                disabled={!!busy}
                onClick={() => setConfirmDeleteCutoff(true)}
              >
                <Trash2 size={16} /> Delete saved cutoff
              </Button>
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
          <section
            className="cutoff-readiness-card"
            aria-label="Cutoff readiness"
          >
            <div className="cutoff-readiness-heading">
              <div>
                <span className="eyebrow">CUTOFF READINESS</span>
                <h2>
                  {workflow.remaining
                    ? `${workflow.remaining} item${workflow.remaining === 1 ? "" : "s"} remaining`
                    : "Ready for final cutoff review"}
                </h2>
                <p>
                  {workflow.progress}% processed · {records.length} employee-day
                  {records.length === 1 ? "" : "s"} analyzed across{" "}
                  {new Set(records.map(key)).size} employee
                  {new Set(records.map(key)).size === 1 ? "" : "s"}.
                </p>
              </div>
              <div className="cutoff-readiness-progress">
                <strong>{workflow.progress}%</strong>
                <progress
                  max={100}
                  value={workflow.progress}
                  aria-label={`${workflow.progress}% of the cutoff processed`}
                />
              </div>
            </div>
            <div className="cutoff-readiness-metrics">
              {[
                ["Completed", workflow.completed.length, "green"],
                ["Action required", workflow.actionRequired.length, "orange"],
                [
                  "Awaiting verification",
                  workflow.awaitingVerification.length,
                  "amber",
                ],
                [
                  "Automatically cleared",
                  workflow.automaticallyCleared.length,
                  "blue",
                ],
              ].map(([label, value, tone]) => (
                <div className="cutoff-readiness-metric" key={String(label)}>
                  <Badge tone={tone as "green" | "orange" | "amber" | "blue"}>
                    {label}
                  </Badge>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <details className="cutoff-checklist" open>
              <summary>Cutoff checklist</summary>
              <div>
                {[
                  ["Overview Attendance imported", batch.sources.length > 0, 0],
                  ["Pivot Working Hours imported", batch.sources.length > 1, 0],
                  ["Data validation completed", true, 0],
                  ["Employee/date coverage completed", records.length > 0, 0],
                  [
                    "Exceptions requiring HR action",
                    workflow.actionRequired.length === 0,
                    workflow.actionRequired.length,
                  ],
                  [
                    "Corrections verified",
                    workflow.awaitingVerification.length === 0,
                    workflow.awaitingVerification.length,
                  ],
                  [
                    "Final cutoff review",
                    workflow.remaining === 0,
                    workflow.remaining,
                  ],
                ].map(([label, complete, remaining]) => (
                  <button
                    key={String(label)}
                    type="button"
                    className="cutoff-checklist-item"
                    onClick={() => {
                      if (Number(remaining) > 0) {
                        setReviewFilter("For Review");
                        setReviewedOnly(false);
                        setResultFilter("");
                        setPage(1);
                      }
                    }}
                  >
                    {complete ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <CircleAlert size={16} />
                    )}
                    <span>{label}</span>
                    {!complete && <strong>{remaining} remaining</strong>}
                  </button>
                ))}
              </div>
            </details>
          </section>
          <section
            className="timekeeping-work-queue"
            aria-label="Timekeeping work queue"
          >
            <div className="timekeeping-work-queue-heading">
              <div>
                <span className="eyebrow">ATTENTION NEEDED</span>
                <h2>Timekeeping work queue</h2>
                <p>
                  Only unresolved employee-days appear here. Completed reviews
                  remain in the audit trail.
                </p>
              </div>
              <Button
                disabled={!workflow.actionRequired.length || !!busy}
                onClick={() => openQueueRecord(workflow.actionRequired[0])}
              >
                <ClipboardCheck size={16} />
                Review next
              </Button>
            </div>
            <div className="timekeeping-work-queue-summary">
              {attendanceSeverities.map((severity) => (
                <button
                  type="button"
                  className="text-link"
                  key={severity}
                  onClick={() => {
                    setSeverityFilter(severity);
                    setReviewFilter("For Review");
                    setEmployee("");
                  }}
                >
                  <SeverityBadge severity={severity} />{" "}
                  {
                    workflow.actionRequired.filter(
                      (r) => attendanceSeverity(r) === severity,
                    ).length
                  }
                </button>
              ))}
              <span>
                <strong>{workflow.actionRequired.length}</strong> action
                required
              </span>
              <span>
                <strong>{workflow.awaitingVerification.length}</strong> awaiting
                verification
              </span>
              <span>
                <strong>{workflow.automaticallyCleared.length}</strong>{" "}
                automatically cleared
              </span>
            </div>
            <div className="timekeeping-work-queue-groups">
              {workflow.groups
                .filter((group) => group.records.length > 0)
                .map((group) => (
                  <details
                    key={group.id}
                    className="timekeeping-work-queue-group"
                  >
                    <summary>
                      <span>
                        <Badge tone="orange">{group.records.length}</Badge>
                        <strong>{group.label}</strong>
                      </span>
                      <span className="muted">View records</span>
                    </summary>
                    <p>{group.description}</p>
                    <div className="timekeeping-work-queue-records">
                      {group.records.slice(0, 5).map((record) => (
                        <button
                          key={record.id}
                          type="button"
                          onClick={() => openQueueRecord(record)}
                        >
                          <span>
                            <strong>{record.employee}</strong>
                            <small>
                              {date(record.date)} ·{" "}
                              {record.location ||
                                record.department ||
                                "Odoo source"}
                            </small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => openQueueGroup(queueGroupFilter(group.id))}
                    >
                      View all {group.records.length}
                    </Button>
                  </details>
                ))}
              {!workflow.actionRequired.length && (
                <div className="timekeeping-work-queue-empty">
                  <CheckCircle2 size={18} />
                  <span>
                    No active HR decisions remain. Complete any verification,
                    then perform final cutoff review.
                  </span>
                </div>
              )}
            </div>
          </section>
          <section
            className="timekeeping-dashboard"
            aria-label="Cutoff overview"
          >
            <div className="timekeeping-dashboard-lead">
              <span className="eyebrow">HR REVIEW QUEUE</span>
              <strong>
                {reviewCount
                  ? `${reviewCount} record${reviewCount === 1 ? "" : "s"} need HR review`
                  : "All records have been reviewed"}
              </strong>
              <p>
                {new Set(records.map(key)).size} employees · {records.length}{" "}
                employee-days · Odoo remains the source record.
              </p>
              <div className="timekeeping-dashboard-context">
                <span>
                  Showing {filtered.length} employee-day
                  {filtered.length === 1 ? "" : "s"}
                </span>
                {activeDashboardMetric && (
                  <Button variant="ghost" onClick={() => filterMetric("")}>
                    Clear queue filter
                  </Button>
                )}
              </div>
            </div>
            <div className="timekeeping-primary-metrics">
              {(
                [
                  {
                    label: "Needs review",
                    value: reviewCount,
                    filter: "review",
                    tone: "attention",
                  },
                  {
                    label: "Negative attendance",
                    value: count("Negative Attendance"),
                    filter: "Negative Attendance",
                    tone: "attention",
                  },
                  {
                    label: "Excessive overtime",
                    value: count("Excessive Overtime"),
                    filter: "Excessive Overtime",
                    tone: "attention",
                  },
                  {
                    label: "Reviewed",
                    value: resolvedCount,
                    filter: "resolved",
                    tone: "success",
                  },
                ] as {
                  label: string;
                  value: number;
                  filter: string;
                  tone: string;
                }[]
              ).map(({ label, value, filter, tone }) => (
                <button
                  className={`timekeeping-metric-filter ${tone}`}
                  key={label}
                  type="button"
                  aria-pressed={activeDashboardMetric === filter}
                  onClick={() => filterMetric(filter)}
                  disabled={!value}
                  title={`Show ${label.toLowerCase()} records`}
                >
                  <span>{label}</span>
                  <strong>{value}</strong>
                </button>
              ))}
            </div>
            <details className="timekeeping-exception-breakdown">
              <summary>View exception breakdown</summary>
              <div className="timekeeping-secondary-metrics">
                {(
                  [
                    {
                      label: "Incomplete attendance",
                      value: count("Incomplete Attendance"),
                      filter: "Incomplete Attendance",
                    },
                    {
                      label: "Missing time in",
                      value: count("Missing Time In"),
                      filter: "Missing Time In",
                    },
                    {
                      label: "Missing time out",
                      value: count("Missing Time Out"),
                      filter: "Missing Time Out",
                    },
                    {
                      label: "No attendance",
                      value: count("No Attendance"),
                      filter: "No Attendance",
                    },
                    {
                      label: "Overtime",
                      value: count("Overtime"),
                      filter: "Overtime",
                    },
                    {
                      label: "Multiple entries",
                      value: count("Multiple Entries"),
                      filter: "Multiple Entries",
                    },
                    {
                      label: "Data discrepancy",
                      value: count("Data Discrepancy"),
                      filter: "Data Discrepancy",
                    },
                  ] as { label: string; value: number; filter: string }[]
                ).map(({ label, value, filter }) => (
                  <button
                    className="timekeeping-secondary-metric"
                    key={label}
                    type="button"
                    aria-pressed={activeDashboardMetric === filter}
                    onClick={() => filterMetric(filter)}
                    disabled={!value}
                  >
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </button>
                ))}
              </div>
              <div className="timekeeping-employee-bulk-action">
                <div>
                  <strong>Overtime-only mass completion</strong>
                  <p className="muted">
                    Across all employees in this cutoff. Exactly one
                    classification: Overtime. Records with Multiple Entries or
                    any other classification stay for review.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={!cutoffOvertimeRows.length || !!busy}
                  onClick={() => {
                    setOvertimeScope("cutoff");
                    setOvertimeCompletionNote(
                      "Overtime-only records reviewed; approval is tracked in the separate overtime-monitoring process.",
                    );
                    setConfirmOvertimeCompletion(true);
                  }}
                >
                  <CheckCircle2 size={16} /> Complete all overtime-only (
                  {cutoffOvertimeRows.length})
                </Button>
              </div>
              <div className="timekeeping-employee-bulk-action">
                <div>
                  <strong>Zero expected hours · system errors</strong>
                  <p className="muted">
                    Resolve verified attendance with 0 expected hours as System
                    / Data Issue. Zero worked hours and mixed attendance issues
                    stay for individual review.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={!zeroExpectedRows.length || !!busy}
                  onClick={() => {
                    setSystemErrorNote(
                      "System / Data Issue: Odoo reported 0 expected hours. Recorded working hours were verified.",
                    );
                    setConfirmSystemErrors(true);
                  }}
                >
                  <CheckCircle2 size={16} /> Resolve all zero expected hours (
                  {zeroExpectedRows.length})
                </Button>
              </div>
            </details>
          </section>
          <details className="card padded spaced timekeeping-source-details">
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
          <Card className="padded spaced timekeeping-review-card">
            <div className="timekeeping-review-heading">
              <div>
                <span className="eyebrow">ATTENDANCE REVIEW</span>
                <h3>Review records</h3>
                <p>Use a queue card above or refine the list below.</p>
              </div>
              <Badge tone={reviewCount ? "orange" : "green"}>
                {filtered.length} shown
              </Badge>
            </div>
            <div className="odoo-filters">
              <Field label="Severity">
                <Select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                >
                  <option value="">All severity levels</option>
                  {attendanceSeverities.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Schedule">
                <Select
                  value={scheduleFilter}
                  onChange={(e) => setScheduleFilter(e.target.value)}
                >
                  <option value="">All schedules</option>
                  {["Workday", "Leave", "Rest Day", "Absent"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
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
                  onChange={(e) => {
                    setResultFilter(e.target.value);
                    setReviewedOnly(false);
                  }}
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
                  onChange={(e) => {
                    setReviewFilter(e.target.value);
                    setReviewedOnly(false);
                  }}
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
            <div className="timekeeping-filter-actions">
              <span>
                {filtered.length} employee-day
                {filtered.length === 1 ? "" : "s"} match this view
              </span>
              {hasReviewFilters && (
                <Button variant="ghost" onClick={clearReviewFilters}>
                  Clear all filters
                </Button>
              )}
            </div>
            <BulkActions
              count={selectedGlobalRows.length}
              total={selectableRows.length}
              allSelected={allGlobalSelected}
              onSelectAll={() =>
                setGlobalIds(
                  allGlobalSelected ? [] : selectableRows.map((r) => r.id),
                )
              }
              onClear={() => setGlobalIds([])}
              busy={!!busy}
            >
              <Select
                aria-label="Attendance bulk action"
                value=""
                onChange={(e) => {
                  setBulkOperation(e.target.value);
                  setGlobalReason("");
                  setGlobalNote("");
                }}
              >
                <option value="">Choose bulk action…</option>
                {[
                  ["resolve", "Mark resolved"],
                  ["confirm-overtime", "Confirm overtime"],
                  ["correction", "Mark for correction"],
                  ["reason", "Assign reason"],
                  ["note", "Add note"],
                  ["reopen", "Reopen for review"],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={() =>
                  void run("Exporting selected attendance", async () => {
                    await downloadFile(
                      "/api/timekeeping",
                      "Daily-Joe-selected-attendance.xlsx",
                      json({
                        action: "export",
                        id: batch.id,
                        recordIds: selectedGlobalRows.map((r) => r.id),
                      }),
                    );
                  })
                }
              >
                Export selected
              </Button>
            </BulkActions>
            {employee ? (
              <>
                <div className="button-row">
                  <Button variant="ghost" onClick={() => setEmployee("")}>
                    <ArrowLeft size={16} />
                    All employees
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!!busy || employeeIndex <= 0}
                    onClick={() => moveEmployee(-1)}
                  >
                    <ArrowLeft size={16} /> Previous employee
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={
                      !!busy ||
                      employeeIndex < 0 ||
                      employeeIndex >= employees.length - 1
                    }
                    onClick={() => moveEmployee(1)}
                  >
                    Next employee <ArrowRight size={16} />
                  </Button>
                </div>
                <h3>{employeeRows[0]?.employee || employee}</h3>
                <p className="muted">
                  {date(batch.period.start)} – {date(batch.period.end)} ·{" "}
                  {batch.rules.timezone}
                </p>
                <div className="timekeeping-employee-bulk-action">
                  <div>
                    <strong>Resolve employee attendance</strong>
                    <p className="muted">
                      Tick records to resolve together, or resolve all pending
                      records for this employee in the current filters.
                    </p>
                  </div>
                  <div className="button-row">
                    <Button
                      variant="secondary"
                      disabled={
                        !!busy ||
                        !employeePendingRows.some((row) =>
                          globalIds.includes(row.id),
                        )
                      }
                      onClick={() =>
                        openBulkReview(
                          employeePendingRows.filter((row) =>
                            globalIds.includes(row.id),
                          ),
                        )
                      }
                    >
                      Resolve selected (
                      {
                        employeePendingRows.filter((row) =>
                          globalIds.includes(row.id),
                        ).length
                      }
                      )
                    </Button>
                    <Button
                      disabled={!!busy || !employeePendingRows.length}
                      onClick={() => openBulkReview(employeePendingRows)}
                    >
                      <CheckCircle2 size={16} /> Resolve all for this employee (
                      {employeePendingRows.length})
                    </Button>
                  </div>
                </div>
                <div className="timekeeping-employee-bulk-action">
                  <div>
                    <strong>Normal overtime completion</strong>
                    <p className="muted">
                      Tick records with Overtime as their only classification.
                      Approval remains in the separate overtime-monitoring
                      process.
                    </p>
                  </div>
                  <div className="timekeeping-overtime-actions">
                    <Button
                      variant="ghost"
                      disabled={!normalOvertimeRows.length || !!busy}
                      onClick={toggleAllNormalOvertime}
                    >
                      {allNormalOvertimeSelected
                        ? "Clear normal overtime"
                        : `Select all overtime (${normalOvertimeRows.length})`}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!selectedNormalOvertime.length || !!busy}
                      onClick={() => {
                        setOvertimeScope("employee");
                        setOvertimeCompletionNote(
                          "Normal overtime reviewed; approval is tracked in the separate overtime-monitoring process.",
                        );
                        setConfirmOvertimeCompletion(true);
                      }}
                    >
                      <CheckCircle2 size={16} />
                      Complete selected ({selectedNormalOvertime.length})
                    </Button>
                  </div>
                </div>
                <Table>
                  <thead>
                    <tr>
                      {[
                        "Resolve",
                        "Date",
                        "Time in / out",
                        "Worked / expected",
                        "Calculated result",
                        "HR review",
                        "Complete",
                        "Details",
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {employeeRows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {needsAction(r) || awaitsVerification(r) ? (
                            <input
                              type="checkbox"
                              disabled={!!busy}
                              aria-label={`Select ${r.employee} on ${date(r.date)} to resolve`}
                              checked={globalIds.includes(r.id)}
                              onChange={(event) => {
                                setGlobalIds((ids) =>
                                  event.target.checked
                                    ? [...new Set([...ids, r.id])]
                                    : ids.filter((id) => id !== r.id),
                                );
                              }}
                            />
                          ) : (
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                aria-label={`Select ${r.employee} on ${r.date}`}
                                checked={globalIds.includes(r.id)}
                                onChange={(e) =>
                                  setGlobalIds((ids) =>
                                    e.target.checked
                                      ? [...new Set([...ids, r.id])]
                                      : ids.filter((id) => id !== r.id),
                                  )
                                }
                              />
                              <CheckCircle2 size={16} aria-label="Resolved" />
                            </label>
                          )}
                        </td>
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
                          <AttendanceCalculation record={r} />
                        </td>
                        <td>
                          <SeverityBadge record={r} />
                          <div className="actions">
                            {r.results.map((s) => (
                              <button
                                className="issue-button"
                                key={s}
                                onClick={() => {
                                  openRecord(r);
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
                            {!!r.review.duplicateResolution?.disregardedRecords
                              ?.length && (
                              <Badge tone="green">
                                Previously multiple entries · corrected
                              </Badge>
                            )}
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
                          {r.review.classification && (
                            <Badge tone="neutral">
                              {r.review.classification}
                            </Badge>
                          )}
                        </td>
                        <td>
                          {isNormalOvertimeForSeparateMonitoring(r) ? (
                            <label className="timekeeping-completion-check">
                              <input
                                type="checkbox"
                                aria-label={`Mark normal overtime on ${date(r.date)} as completed`}
                                checked={selectedOvertimeIds.includes(r.id)}
                                onChange={(event) =>
                                  setSelectedOvertimeIds((current) =>
                                    event.target.checked
                                      ? [...current, r.id]
                                      : current.filter((id) => id !== r.id),
                                  )
                                }
                              />
                              Overtime monitored
                            </label>
                          ) : (
                            <small className="muted">Individual review</small>
                          )}
                        </td>
                        <td>
                          <div className="timekeeping-table-actions">
                            {classificationsFor(r).length > 0 &&
                              !r.review.classification && (
                                <label className="timekeeping-inline-classification">
                                  <span>Possible classification</span>
                                  <Select
                                    aria-label={`Choose a possible classification for ${r.employee} on ${date(r.date)}`}
                                    value=""
                                    onChange={(event) => {
                                      const choice = event.target
                                        .value as AttendanceClassification;
                                      if (choice)
                                        beginClassification(r, choice);
                                    }}
                                  >
                                    <option value="">Choose…</option>
                                    {classificationsFor(r).map((choice) => (
                                      <option key={choice} value={choice}>
                                        {choice}
                                      </option>
                                    ))}
                                  </Select>
                                </label>
                              )}
                            <Button
                              variant="ghost"
                              onClick={() => {
                                openRecord(r);
                              }}
                            >
                              Review <ChevronRight size={15} />
                            </Button>
                          </div>
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
                      .map(([id, rows]) => {
                        const summary = employeeAttendanceSummary(
                          allEmployeeRows.get(id) || rows,
                        );
                        return (
                          <tr key={id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select filtered attendance for ${rows[0].employee}`}
                                checked={rows.every((r) =>
                                  globalIds.includes(r.id),
                                )}
                                disabled={!!busy}
                                onChange={(e) =>
                                  setGlobalIds((ids) =>
                                    e.target.checked
                                      ? [
                                          ...new Set([
                                            ...ids,
                                            ...rows.map((r) => r.id),
                                          ]),
                                        ]
                                      : ids.filter(
                                          (selectedId) =>
                                            !rows.some(
                                              (r) => r.id === selectedId,
                                            ),
                                        ),
                                  )
                                }
                              />
                              <SeverityBadge
                                record={
                                  [...rows].sort(
                                    (a, b) =>
                                      attendanceSeverities.indexOf(
                                        attendanceSeverity(a),
                                      ) -
                                      attendanceSeverities.indexOf(
                                        attendanceSeverity(b),
                                      ),
                                  )[0]
                                }
                              />
                              <strong>{rows[0].employee}</strong>
                              <small className="muted">
                                {rows[0].employeeId || "Matched by source name"}
                              </small>
                            </td>
                            <td>
                              <strong>{summary.cutoffDays} cutoff days</strong>
                              <small className="muted">
                                {summary.recordedDays} recorded ·{" "}
                                {summary.normalDays} normal
                                {" · "}
                                {summary.leaveDays} leave ·{" "}
                                {summary.absenceDays} absence ·{" "}
                                {summary.restDays} rest
                              </small>
                            </td>
                            <td>
                              {hours(
                                rows.reduce(
                                  (sum, r) => sum + (r.worked ?? 0),
                                  0,
                                ),
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
                                  {
                                    rows.filter((r) => r.expected === null)
                                      .length
                                  }{" "}
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
                                {summary.unresolved} remaining
                              </Badge>
                              {(summary.resolved > 0 ||
                                summary.clarification > 0) && (
                                <small className="muted">
                                  {summary.resolved} resolved ·{" "}
                                  {summary.clarification} need classification
                                </small>
                              )}
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
                        );
                      })}
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
      {confirmDeleteCutoff && batch && (
        <Modal
          title="Permanently delete saved cutoff?"
          busy={!!busy}
          onClose={() => setConfirmDeleteCutoff(false)}
        >
          <p>
            <strong>
              {date(batch.period.start)} – {date(batch.period.end)}
            </strong>{" "}
            · {batch.records.length} attendance records
          </p>
          <p>
            This permanently removes this cutoff’s analysis, saved versions,
            attendance records, review notes and related processing data from
            the database. It cannot be restored. Export it first if you need a
            copy.
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => setConfirmDeleteCutoff(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!!busy}
              onClick={() =>
                void run("Deleting saved cutoff", async () => {
                  const id = batch.id;
                  await requestJson(
                    "/api/timekeeping",
                    json({
                      action: "delete-cutoff",
                      id,
                      revision: batch.revision,
                      confirmed: true,
                    }),
                  );
                  setBatches((current) =>
                    current.filter((index) => index.id !== id),
                  );
                  setBatch(null);
                  setPreview(null);
                  setEmployee("");
                  setDetail("");
                  setSelectedOvertimeIds([]);
                  setJob(null);
                  sessionStorage.removeItem("djc-timekeeping-job");
                  const url = new URL(window.location.href);
                  url.searchParams.delete("batch");
                  window.history.replaceState(null, "", url);
                  setConfirmDeleteCutoff(false);
                  notify("Saved cutoff permanently deleted from the database.");
                  void refresh({ background: true });
                })
              }
            >
              <Trash2 size={16} /> Permanently delete
            </Button>
          </div>
        </Modal>
      )}
      {confirmOvertimeCompletion && batch && (
        <Modal
          title={
            overtimeScope === "cutoff"
              ? "Complete all overtime-only records"
              : "Complete selected overtime-only records"
          }
          busy={!!busy}
          onClose={() => setConfirmOvertimeCompletion(false)}
        >
          <p>
            Mark <strong>{completionRows.length}</strong> overtime-only record
            {completionRows.length === 1 ? "" : "s"} completed for{" "}
            <strong>
              {overtimeScope === "cutoff"
                ? completionEmployees + " employees across this entire cutoff"
                : employeeRows[0]?.employee || "this employee"}
            </strong>
            ?
          </p>
          <p className="muted">
            Only records with exactly one classification, Overtime, are
            included. Mixed classifications, including Overtime with Multiple
            Entries, remain for review. Overtime approval stays in the separate
            monitoring process.
          </p>
          <Field label="Completion note (optional)">
            <RichTextEditor
              rows={3}
              maxLength={4000}
              value={overtimeCompletionNote}
              onChange={setOvertimeCompletionNote}
            />
          </Field>
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => setConfirmOvertimeCompletion(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!completionRows.length || !!busy}
              onClick={() =>
                void run("Completing normal overtime", async () => {
                  const result = await requestJson<{ batch: OdooBatch }>(
                    "/api/timekeeping",
                    json({
                      action: "complete-normal-overtime",
                      id: batch.id,
                      revision: batch.revision,
                      scope: overtimeScope,
                      ...(overtimeScope === "employee"
                        ? {
                            employeeKey: employee,
                            recordIds: completionRows.map(
                              (record) => record.id,
                            ),
                          }
                        : {}),
                      note: overtimeCompletionNote,
                    }),
                  );
                  setBatch(result.batch);
                  setSelectedOvertimeIds([]);
                  setConfirmOvertimeCompletion(false);
                  notify(
                    `${completionRows.length} overtime-only record${completionRows.length === 1 ? "" : "s"} marked completed for separate overtime monitoring.`,
                  );
                })
              }
            >
              <CheckCircle2 size={16} />
              Confirm completion
            </Button>
          </div>
        </Modal>
      )}
      {confirmSystemErrors && batch && (
        <Modal
          title="Resolve zero expected hours system errors"
          onClose={() => {
            if (!busy) setConfirmSystemErrors(false);
          }}
        >
          <p>
            Mark {zeroExpectedRows.length} records across this cutoff as
            Resolved with System / Data Issue classification. This action
            applies only to verified attendance with 0 expected hours.
          </p>
          <Field label="System error / verification note">
            <RichTextEditor
              value={systemErrorNote}
              onChange={setSystemErrorNote}
              maxLength={4000}
              rows={3}
            />
          </Field>
          <Button
            disabled={!!busy || !zeroExpectedRows.length}
            onClick={() =>
              void run("Resolving zero expected hours", async () => {
                const update = await requestJson<ReviewUpdate>(
                  "/api/timekeeping",
                  json({
                    action: "resolve-zero-expected",
                    compact: true,
                    id: batch.id,
                    revision: batch.revision,
                    note: systemErrorNote,
                  }),
                );
                applySavedReview(update);
                setConfirmSystemErrors(false);
                notify(
                  `${zeroExpectedRows.length} zero expected hours records resolved as System / Data Issue.`,
                );
              })
            }
          >
            <CheckCircle2 size={16} /> Resolve all zero expected hours
          </Button>
        </Modal>
      )}
      {bulkOperation && batch && (
        <Modal
          title={`${selectedGlobalRows.length} records · ${bulkOperation}`}
          onClose={() => !busy && setBulkOperation("")}
        >
          <p>
            This action applies to all selected records across the current
            filtered results. Source attendance and previous reviews remain in
            the audit trail.
          </p>
          <Field label="Reason (required for unclassified missing / short attendance)">
            <Select
              value={globalReason}
              onChange={(e) => setGlobalReason(e.target.value)}
            >
              <option value="">Keep existing classification</option>
              {[
                "Late",
                "Undertime",
                "Early Out",
                "Absent",
                "Day Off",
                "Leave",
                "System / Data Issue",
                "Other",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Note">
            <Input
              value={globalNote}
              onChange={(e) => setGlobalNote(e.target.value)}
            />
          </Field>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() => setBulkOperation("")}
            >
              Cancel
            </Button>
            <Button
              disabled={!!busy || !selectedGlobalRows.length}
              onClick={() =>
                void run("Saving bulk attendance review", async () => {
                  const result = await requestJson<{ batch: OdooBatch }>(
                    "/api/timekeeping",
                    json({
                      action: "bulk-review",
                      id: batch.id,
                      revision: batch.revision,
                      allFiltered: allGlobalSelected && !reviewedOnly,
                      filters: bulkFilters,
                      recordIds: selectedGlobalRows.map((r) => r.id),
                      expectedCount: selectedGlobalRows.length,
                      operation: bulkOperation,
                      classification: globalReason || undefined,
                      note: globalNote,
                      confirmed: true,
                    }),
                  );
                  setBatch(result.batch);
                  setGlobalIds([]);
                  setBulkOperation("");
                  notify(
                    `${selectedGlobalRows.length} attendance records updated.`,
                  );
                })
              }
            >
              {busy || "Confirm bulk action"}
            </Button>
          </div>
        </Modal>
      )}
      {bulkRows.length > 0 && batch && (
        <Modal
          title={`Resolve ${bulkRows.length} attendance records · ${bulkRows[0].employee}`}
          onClose={() => {
            if (!busy) setBulkRows([]);
          }}
        >
          <p>
            These records will be marked Resolved in one save. Confirm any
            missing classifications and which duplicate entries to keep.
          </p>
          {bulkRows.map((row) => (
            <Card key={row.id} className="spaced">
              <strong>
                {date(row.date)} · {row.results.join(" · ")}
              </strong>
              {classificationsFor(row).length > 0 && (
                <Field label="Attendance classification">
                  <Select
                    value={bulkDecisions[row.id]?.classification || ""}
                    onChange={(event) =>
                      setBulkDecisions((current) => ({
                        ...current,
                        [row.id]: {
                          ...current[row.id],
                          classification: event.target.value as
                            AttendanceClassification | "",
                        },
                      }))
                    }
                  >
                    <option value="">Choose…</option>
                    {classificationsFor(row).map((choice) => (
                      <option key={choice}>{choice}</option>
                    ))}
                  </Select>
                </Field>
              )}
              {row.results.includes("Multiple Entries") &&
                row.raw.map((source) => (
                  <label className="checkbox-label" key={source.row}>
                    <input
                      type="checkbox"
                      checked={
                        bulkDecisions[row.id]?.retainedSourceRows.includes(
                          source.row,
                        ) || false
                      }
                      onChange={(event) =>
                        setBulkDecisions((current) => ({
                          ...current,
                          [row.id]: {
                            ...current[row.id],
                            retainedSourceRows: event.target.checked
                              ? [
                                  ...current[row.id].retainedSourceRows,
                                  source.row,
                                ]
                              : current[row.id].retainedSourceRows.filter(
                                  (id) => id !== source.row,
                                ),
                          },
                        }))
                      }
                    />
                    Keep row {source.row} ·{" "}
                    {source.checkIn || "Missing time-in"} →{" "}
                    {source.checkOut || "Missing time-out"} ·{" "}
                    {hours(source.worked)} h
                  </label>
                ))}
            </Card>
          ))}
          <Field label="Resolution / verification note (optional)">
            <RichTextEditor
              value={bulkNote}
              onChange={setBulkNote}
              maxLength={4000}
              rows={2}
            />
          </Field>
          <Button
            disabled={
              !!busy ||
              bulkRows.some(
                (row) =>
                  (classificationsFor(row).length > 0 &&
                    !bulkDecisions[row.id]?.classification) ||
                  (row.results.includes("Multiple Entries") &&
                    !bulkDecisions[row.id]?.retainedSourceRows.length),
              )
            }
            onClick={() =>
              void run("Resolving employee attendance", async () => {
                const update = await requestJson<ReviewUpdate>(
                  "/api/timekeeping",
                  json({
                    action: "resolve-employee",
                    compact: true,
                    id: batch.id,
                    revision: batch.revision,
                    employeeKey: key(bulkRows[0]),
                    note: bulkNote,
                    records: bulkRows.map((row) => ({
                      recordId: row.id,
                      classification:
                        bulkDecisions[row.id].classification || undefined,
                      duplicateResolution: row.results.includes(
                        "Multiple Entries",
                      )
                        ? {
                            retainedSourceRows:
                              bulkDecisions[row.id].retainedSourceRows,
                            disregardedSourceRows: row.raw
                              .filter(
                                (source) =>
                                  !bulkDecisions[
                                    row.id
                                  ].retainedSourceRows.includes(source.row),
                              )
                              .map((source) => source.row),
                          }
                        : undefined,
                    })),
                  }),
                );
                const changed = new Map(
                  update.records.map((row) => [row.id, row]),
                );
                applySavedReview(update);
                setGlobalIds((current) =>
                  current.filter((id) => !changed.has(id)),
                );
                setBulkRows([]);
                notify(
                  `${update.records.length} attendance records resolved for ${bulkRows[0].employee}.`,
                );
              })
            }
          >
            <CheckCircle2 size={16} /> Resolve {bulkRows.length} records
          </Button>
        </Modal>
      )}
      {selected && batch && (
        <Modal
          title={`${selected.employee} · ${date(selected.date)}`}
          busy={!!busy}
          onClose={() => {
            setDetail("");
            setReviewNext(false);
          }}
        >
          {reviewNext && (
            <div className="review-next-card-heading">
              <ClipboardCheck size={17} />
              <span>
                Review next · {workflow.actionRequired.length} active item
                {workflow.actionRequired.length === 1 ? "" : "s"} in queue
              </span>
            </div>
          )}
          <div className="button-row">
            <Button
              variant="secondary"
              disabled={!!busy || detailEmployeeIndex <= 0}
              onClick={() => moveEmployee(-1, true)}
            >
              <ArrowLeft size={16} /> Previous employee
            </Button>
            <Button
              variant="secondary"
              disabled={
                !!busy ||
                detailEmployeeIndex < 0 ||
                detailEmployeeIndex >= employees.length - 1
              }
              onClick={() => moveEmployee(1, true)}
            >
              Next employee <ArrowRight size={16} />
            </Button>
          </div>
          <p className="muted">
            Review attendance and keep the main source entries when correcting
            duplicates.
          </p>
          {!!selected.review.duplicateResolution?.disregardedRecords
            ?.length && (
            <Badge tone="green">Previously multiple entries · corrected</Badge>
          )}
          <div className="actions">
            {selected.results.map((s) => (
              <span className="timekeeping-status-with-help" key={s}>
                <Badge tone="amber">{s}</Badge>
                {!/[Nn]ormal|Rest Day/.test(s) && (
                  <HelpTip>
                    {issueExplanation(
                      selected,
                      batch.rules.excessiveWorkedHours ?? 16,
                    )}
                  </HelpTip>
                )}
              </span>
            ))}
          </div>
          <SeverityBadge record={selected} />
          <AttendanceCalculation record={selected} />
          <div className="review-next-facts">
            <span>
              <strong>Employee ID</strong>
              {selected.employeeId || "Not supplied"}
            </span>
            <span>
              <strong>Branch</strong>
              {selected.location || "Not supplied"}
            </span>
            <span>
              <strong>Expected schedule</strong>
              {batch.rules.start && batch.rules.end
                ? `${batch.rules.start}–${batch.rules.end}`
                : "Not configured"}
            </span>
            <span>
              <strong>Time in / out</strong>
              {clockTime(
                selected.checkIn,
                batch.rules.timezone,
                selected.date,
              )}{" "}
              →{" "}
              {clockTime(
                selected.checkOut,
                batch.rules.timezone,
                selected.date,
              )}
            </span>
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
          {classificationsFor(selected).length > 0 && (
            <section className="attendance-classification">
              <span className="eyebrow">Possible classification</span>
              <p>
                {selected.results.includes("Negative Attendance")
                  ? "Odoo cannot determine whether this negative attendance is late, undertime, or early out. HR must confirm one."
                  : "No attendance does not establish absence. HR must confirm the appropriate classification."}
              </p>
              <div className="button-row">
                {classificationsFor(selected).map((choice) => (
                  <Button
                    key={choice}
                    variant={
                      pendingClassification === choice ||
                      (!pendingClassification && classification === choice)
                        ? "primary"
                        : "secondary"
                    }
                    onClick={() => setPendingClassification(choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
              {classification && (
                <p className="classification-current">
                  Confirmed classification: <strong>{classification}</strong>
                </p>
              )}
              {pendingClassification && (
                <div className="classification-confirmation" role="alert">
                  <strong>Confirm attendance classification</strong>
                  <span>
                    {selected.employee} · {date(selected.date)} ·{" "}
                    {selected.difference === null
                      ? "No attendance"
                      : `${hours(selected.difference)} hour variance`}
                  </span>
                  <p>
                    Classify this record as{" "}
                    <strong>{pendingClassification}</strong>?
                  </p>
                  {pendingClassification === "Other" && (
                    <Field label="HR note (optional)">
                      <RichTextEditor
                        rows={2}
                        maxLength={4000}
                        value={note}
                        onChange={setNote}
                        placeholder="Explain the classification for the cutoff audit trail."
                      />
                    </Field>
                  )}
                  <small className="muted">
                    Confirming prepares this record as resolved. Save review to
                    record it and update the active queue.
                  </small>
                  <div className="button-row">
                    <Button
                      variant="secondary"
                      onClick={() => setPendingClassification("")}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        setClassification(pendingClassification);
                        setPendingClassification("");
                        setReview("Resolved");
                      }}
                    >
                      Confirm classification
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
          <details open>
            <summary>
              Attendance source records ({selected.raw.length})
              {selected.raw.length > 1
                ? " · duplicate comparison required"
                : ""}
            </summary>
            {selected.raw.length ? (
              <>
                {selected.raw.length > 1 && (
                  <p className="muted">
                    Keep the main attendance entry, or the valid split-shift
                    entries. When resolved, unchecked entries are removed from
                    this active day and retained in correction history.
                  </p>
                )}
                <Table>
                  <thead>
                    <tr>
                      {selected.raw.length > 1 && <th>Keep</th>}
                      <th>Row / source name</th>
                      <th>Check In</th>
                      <th>Check Out</th>
                      <th>Worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.raw.map((r) => (
                      <tr key={r.row}>
                        {selected.raw.length > 1 && (
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Keep attendance source row ${r.row}`}
                              checked={retainedSourceRows.includes(r.row)}
                              onChange={(event) =>
                                setRetainedSourceRows((current) =>
                                  event.target.checked
                                    ? [...current, r.row]
                                    : current.filter((row) => row !== r.row),
                                )
                              }
                            />
                          </td>
                        )}
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
              </>
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
          <Field label="Resolution / verification note (optional)">
            <RichTextEditor
              rows={3}
              maxLength={4000}
              value={note}
              onChange={setNote}
              placeholder="Record the evidence and reason for this review."
            />
          </Field>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={correctedInOdoo}
              onChange={(e) => setCorrectedInOdoo(e.target.checked)}
            />
            Corrected in Odoo
          </label>
          <Button
            disabled={!!busy}
            onClick={() =>
              void run("Saving review", async () => {
                const r = await requestJson<ReviewUpdate>(
                  "/api/timekeeping",
                  json({
                    action: "review",
                    compact: true,
                    id: batch.id,
                    revision: batch.revision,
                    recordId: selected.id,
                    status: review,
                    note,
                    classification: classification || undefined,
                    correctedInOdoo,
                    duplicateResolution:
                      selected.raw.length > 1
                        ? {
                            retainedSourceRows,
                            disregardedSourceRows: selected.raw
                              .map((source) => source.row)
                              .filter(
                                (row) => !retainedSourceRows.includes(row),
                              ),
                          }
                        : undefined,
                  }),
                );
                const updated = mergeAttendanceReview(batch, r);
                applySavedReview(r);
                const next = cutoffWorkflow(
                  updated.records,
                ).actionRequired.find((record) => record.id !== selected.id);
                notify(
                  next && reviewNext
                    ? "Review saved. Loading the next unresolved record."
                    : "Attendance review saved.",
                );
                if (next && reviewNext) openRecord(next);
                else {
                  setDetail("");
                  setReviewNext(false);
                }
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
                <div key={i} className="timekeeping-history-entry">
                  {h.previous} → {h.next}
                  <br />
                  {h.reviewer} ·{" "}
                  {formatDate(h.timestamp, state?.preferences, true)}
                  <br />
                  <RichTextContent value={h.note} />
                </div>
              ))
            ) : (
              <p>No HR review has been recorded.</p>
            )}
          </details>
        </Modal>
      )}
    </div>
  );
}
