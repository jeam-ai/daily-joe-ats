"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  ArrowUpRight,
  Download,
  LoaderCircle,
} from "lucide-react";
import { useApp } from "./provider";
import {
  ApplicantCard,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  StatusBadge,
  StageLegend,
  Table,
  Tabs,
  LoadingSkeleton,
} from "./ui";
import type { Application } from "@/types";
import { canManage, canEdit, INTAKE_QUEUE_LIMIT } from "@/lib/data-policy";
import { requestJson, downloadFile } from "@/lib/client-request";
import { ApplicantEditor, DeleteApplicantDialog } from "./applicant-management";
import { ActionMenu } from "./action-menu";
import { SelectionHelp, SelectionSurface } from "./record-selection";
import {
  formatDate,
  monthKey,
  dayKey,
  monthStartIso,
  scheduledIso,
} from "@/lib/dates";
import { applicantDisplayName } from "@/lib/applicant-information";
import { BulkActions } from "./bulk-actions";
import { ApplicantBulkDialog } from "./applicant-bulk-dialog";
import { ApplicantReprocess } from "./applicant-reprocess";
import {
  applicantNavigationScope,
  rememberApplicantNavigation,
  type ApplicantNeighbors,
} from "@/lib/applicant-navigation";
const daysUntil = (timestamp: number) =>
  Math.max(0, Math.ceil((timestamp - Date.now()) / 86400000));
function talentRetentionWarning(application: Application) {
  const started = Date.parse(
    application.talentPoolAddedAt || application.appliedAt,
  );
  const expires = application.talentPoolExpiresAt
    ? Date.parse(application.talentPoolExpiresAt)
    : started + 30 * 86400000;
  const graceEnds = application.talentPoolGraceExpiresAt
    ? Date.parse(application.talentPoolGraceExpiresAt)
    : started + 40 * 86400000;
  if (!Number.isFinite(expires) || !Number.isFinite(graceEnds))
    return "Talent Pool expiration date needs review.";
  const poolDays = daysUntil(expires);
  if (poolDays > 0)
    return `Talent Pool expires in ${poolDays} day${poolDays === 1 ? "" : "s"}`;
  const graceDays = daysUntil(graceEnds);
  return graceDays > 0
    ? `Talent Pool grace ends in ${graceDays} day${graceDays === 1 ? "" : "s"}. Retain to keep in pool.`
    : "Talent Pool grace ended. Retain to keep in pool.";
}
export function Applications({ talent = false }: { talent?: boolean }) {
  const { state, notify, dataset } = useApp();
  const router = useRouter();
  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const [deleting, setDeleting] = useState<Application | null>(null);
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const [needFilter, setNeedFilter] = useState(params.get("need") || "");
  const [status, setStatus] = useState(params.get("status") || "");
  const [stage, setStage] = useState(params.get("stage") || "");
  const [position, setPosition] = useState(params.get("position") || "");
  const [location, setLocation] = useState(params.get("location") || "");
  const [screening, setScreening] = useState(params.get("screening") || "");
  const [date, setDate] = useState(
    params.get("date") || (params.get("month") === "current" ? "month" : ""),
  );
  const [experience, setExperience] = useState(params.get("experience") || "");
  const [tab, setTab] = useState(
    params.get("tab") ||
      (params.get("view") === "interviews" ? "Interviews" : "All applications"),
  );
  const [page, setPage] = useState(
    Math.floor(Math.max(1, Math.min(100000, Number(params.get("page")) || 1))),
  );
  const [employmentStatus, setEmploymentStatus] = useState(
    params.get("employment") || "",
  );
  const [urgency, setUrgency] = useState(params.get("urgency") || "");
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [allSelected, setAllSelected] = useState(false);
  const [bulkAction, setBulkAction] = useState("");
  const [individualScreeningId, setIndividualScreeningId] = useState("");
  const selectionRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setQ(params.get("q") || "");
    setNeedFilter(params.get("need") || "");
    setStatus(params.get("status") || "");
    setStage(params.get("stage") || "");
    setPosition(params.get("position") || "");
    setLocation(params.get("location") || "");
    setScreening(params.get("screening") || "");
    setExperience(params.get("experience") || "");
    setUrgency(params.get("urgency") || "");
    setEmploymentStatus(params.get("employment") || "");
    setDate(
      params.get("date") || (params.get("month") === "current" ? "month" : ""),
    );
    setTab(
      params.get("tab") ||
        (params.get("view") === "interviews"
          ? "Interviews"
          : "All applications"),
    );
    setPage(
      Math.floor(
        Math.max(1, Math.min(100000, Number(params.get("page")) || 1)),
      ),
    );
  }, [params]);
  const [listing, setListing] = useState<{
      applications: Application[];
      total: number;
      page: number;
      neighborsById: Record<string, ApplicantNeighbors>;
    }>(),
    [listError, setListError] = useState(""),
    [listLoading, setListLoading] = useState(true),
    [reload, setReload] = useState(0);
  const queryParams = new URLSearchParams({
    q,
    need: needFilter,
    status,
    stage,
    position,
    location,
    screening,
    experience,
    urgency,
    employment: tab === "Hired" ? employmentStatus : "",
    page: String(page),
    tab,
    sort:
      !talent && ["All applications", "Queued"].includes(tab)
        ? "activity"
        : "received",
    talent: talent ? "1" : "0",
    date,
    since:
      date === "week"
        ? scheduledIso(
            `${dayKey(Date.now() - 7 * 86400000, state?.preferences.timezone)}T00:00`,
            state?.preferences.timezone,
          )
        : date === "month"
          ? monthStartIso(Date.now(), state?.preferences.timezone)
          : "",
  }).toString();
  const filterParams = new URLSearchParams(queryParams);
  filterParams.delete("page");
  const selectionFilters = filterParams.toString();
  const navigationScope = applicantNavigationScope(
    queryParams,
    dataset,
    state?.currentUser?.email,
    state?.revision,
  );
  useEffect(() => {
    selectionRequest.current?.abort();
    setSelecting(false);
    setSelectedIds([]);
    setAllSelected(false);
    return () => selectionRequest.current?.abort();
  }, [selectionFilters, dataset]);
  useEffect(() => {
    const abort = new AbortController();
    setListLoading(true);
    setListError("");
    const timer = setTimeout(() => {
      requestJson<{
        applications: Application[];
        total: number;
        page: number;
        neighborsById: Record<string, ApplicantNeighbors>;
      }>(`/api/applications?${queryParams}`, { signal: abort.signal })
        .then((r) => {
          if (!abort.signal.aborted) {
            rememberApplicantNavigation(navigationScope, r.neighborsById || {});
            setListing(r);
          }
        })
        .catch((e) => {
          if (!abort.signal.aborted) setListError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setListLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [queryParams, navigationScope, reload]);
  if (!state) return <LoadingSkeleton />;
  const selectedNeed = state.hiringNeeds.find((need) => need.id === needFilter);
  const rows = listing?.applications || [],
    total = listing?.total ?? 0;
  const resultsUnavailable = listLoading || selecting || !!listError;
  const pageCount = Math.max(1, Math.ceil(total / 20)),
    currentPage = listing?.page || page,
    visible = rows;
  const profileHref = (id: string) =>
    `/applications/${encodeURIComponent(id)}?list=${encodeURIComponent(queryParams)}`;
  async function toggleAllFiltered() {
    if (allSelected) {
      setSelectedIds([]);
      setAllSelected(false);
      return;
    }
    const abort = new AbortController();
    selectionRequest.current = abort;
    setSelecting(true);
    try {
      const result = await requestJson<{ ids: string[] }>(
        `/api/applications?${selectionFilters}&selection=ids`,
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) {
        setSelectedIds(result.ids);
        setAllSelected(true);
      }
    } catch (e) {
      if (!abort.signal.aborted) notify((e as Error).message, "error");
    } finally {
      if (!abort.signal.aborted) setSelecting(false);
    }
  }
  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(
        `/api/tracker${talent ? "?scope=talent" : ""}`,
        `Daily-Joe-Careers-${talent ? "Talent-Pool" : "Applications"}.xlsx`,
      );
      notify("Tracker downloaded. Demo records are excluded.");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div
        className={`page-heading workspace-page-heading ${talent ? "talent-pool-heading" : ""}`}
      >
        <div>
          <div className="eyebrow">
            {talent ? "KEEP THE CONNECTION" : "PEOPLE & POSSIBILITIES"}
          </div>
          <h1>{talent ? "Talent Pool" : "Applications"}</h1>
          <p>
            {talent
              ? "Good people, ready for the right opportunity."
              : "A thoughtful next step for every applicant."}
          </p>
        </div>
        <div className="workspace-heading-side">
          <span className="workspace-heading-context">
            {talent ? "Candidate relationship workspace" : "Applicant workflow"}
          </span>
          <div className="button-row">
            {!talent && dataset === "real" && (
              <>
                <a
                  className="button secondary"
                  href="/settings/integrations#intake"
                >
                  Import Applications
                </a>
                <Button
                  disabled={!canManage(state.currentUser)}
                  title={
                    !canManage(state.currentUser)
                      ? "Recruitment manager access required"
                      : undefined
                  }
                  onClick={() => setEditing("new")}
                >
                  + Add Applicant
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              onClick={() => void exportCsv()}
              disabled={exporting || dataset === "demo"}
              title={
                dataset === "demo"
                  ? "Exit Demo to export real applications"
                  : undefined
              }
            >
              <Download size={16} />
              {exporting
                ? "Preparing tracker…"
                : `Export ${talent ? "talent pool" : "applications"}`}
            </Button>
          </div>
        </div>
      </div>
      <p className="workspace-heading-note">
        {talent
          ? "Keep promising candidates organized and ready for the right future opening."
          : "Review each application with clear evidence, a consistent stage, and an auditable next step."}
      </p>
      <Card
        className={`workspace-card ${talent ? "talent-pool-workspace" : ""}`}
      >
        {state.intakePaused && dataset === "real" && (
          <p className="warning-banner">
            Gmail intake is paused for this fresh workspace. When you are ready,
            reconnect Gmail and resume intake in Settings → Appearance &
            Preferences.
          </p>
        )}
        <StageLegend />
        {!talent && dataset === "real" && (
          <p className="padded fine-print">
            Latest 100 active applications ·{" "}
            {state.applicationSummary?.[dataset].active ?? 0} active ·{" "}
            {state.applicationSummary?.[dataset].queued ?? 0} queued within the{" "}
            {INTAKE_QUEUE_LIMIT}-application live queue. Gmail intake continues
            beyond the queue; older records receive retention review and
            protected active applications remain available.
            {tab === "All applications" &&
              " This list is sorted by latest Gmail thread activity; a reply can move an existing applicant to the top without changing their original application date."}
          </p>
        )}
        {!talent && (
          <Tabs
            items={[
              "All applications",
              "Active",
              "Queued",
              "Interviews",
              "Pre-employment",
              "Onboarding",
              "Hired",
            ]}
            value={tab}
            onChange={(value) => {
              setTab(value);
              setPage(1);
            }}
          />
        )}
        <div className="filter-bar">
          {needFilter && (
            <Button
              variant="secondary"
              onClick={() => {
                setNeedFilter("");
                setPage(1);
              }}
              title="Remove the hiring need filter"
            >
              Hiring need:{" "}
              {selectedNeed
                ? `${selectedNeed.position} · ${selectedNeed.location}`
                : "Selected hiring need"}{" "}
              ×
            </Button>
          )}
          <div className="search-field">
            <Search size={17} />
            <Input
              aria-label="Search applications"
              placeholder="Search name, email, phone, role, or branch"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            aria-label="Position"
            value={position}
            onChange={(e) => {
              setPosition(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All positions</option>
            {Array.from(
              new Set([
                ...state.qualifications.map((v) => v.position),
                ...state.applications.map((v) => v.position),
              ]),
            ).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
          <Select
            aria-label="Location"
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All locations</option>
            {(state.locations || [])
              .map((l) => l.name)
              .map((v) => (
                <option key={v}>{v}</option>
              ))}
          </Select>
          <Select
            aria-label="Screening result"
            value={screening}
            onChange={(e) => {
              setScreening(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All screening results</option>
            {["Meets Criteria", "Requires Review", "Criteria Not Met"].map(
              (v) => (
                <option key={v}>{v}</option>
              ),
            )}
          </Select>
        </div>
        <div className="filter-bar secondary-filters">
          <SlidersHorizontal size={16} />
          <Select
            aria-label="Urgency"
            value={urgency}
            onChange={(e) => {
              setUrgency(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All urgency levels</option>
            {["Urgent", "High", "Medium", "Low"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
          {tab === "Hired" && (
            <Select
              aria-label="Employment status"
              value={employmentStatus}
              onChange={(e) => {
                setEmploymentStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All employment statuses</option>
              {["Active", "Resigned", "Terminated"].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </Select>
          )}
          {!talent && (
            <>
              <Select
                aria-label="Status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {[
                  "New",
                  "For Review",
                  "Approved",
                  "In Progress",
                  "Hired",
                  "Rejected",
                  "Withdrawn",
                  "No Response",
                  "Talent Pool",
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
              <Select
                aria-label="Recruitment stage"
                value={stage}
                onChange={(e) => {
                  setStage(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All stages</option>
                {[
                  "Screening",
                  "Initial Interview",
                  "Final Interview",
                  "Requirements",
                  "Onboarding",
                  "Hired",
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
            </>
          )}
          {talent && (
            <Select
              aria-label="Experience"
              value={experience}
              onChange={(e) => {
                setExperience(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any experience</option>
              <option value="2">2+ years</option>
              <option value="4">4+ years</option>
            </Select>
          )}
          <Select
            aria-label={talent ? "Date added" : "Application date"}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any date</option>
            <option value="week">Last 7 days</option>
            <option value="month">This month</option>
          </Select>
          <button
            className="text-link"
            onClick={() => {
              setUrgency("");
              setNeedFilter("");
              setTab("All applications");
              setPage(1);
              setQ("");
              setStatus("");
              setStage("");
              setPosition("");
              setLocation("");
              setScreening("");
              setDate("");
              setExperience("");
              setEmploymentStatus("");
            }}
          >
            Clear filters
          </button>
          <span className="result-count">
            {total}{" "}
            {talent
              ? total === 1
                ? "candidate"
                : "candidates"
              : total === 1
                ? "application"
                : "applications"}
          </span>
        </div>
        {listError && (
          <div className="error-banner" role="alert">
            {listError}
            <Button variant="secondary" onClick={() => setReload((v) => v + 1)}>
              Retry
            </Button>
          </div>
        )}
        <div className="search-feedback" role="status" aria-live="polite">
          {listLoading ? (
            <>
              <LoaderCircle size={16} className="loading-spinner" /> Searching
              applicants…
            </>
          ) : listError ? (
            "Search could not complete. Retry to refresh results."
          ) : (
            `${total} applicant${total === 1 ? "" : "s"} found${q ? ` for “${q}”` : ""}`
          )}
        </div>
        {canManage(state.currentUser) && <SelectionHelp />}
        {canManage(state.currentUser) && (
          <BulkActions
            count={selectedIds.length}
            total={total}
            allSelected={allSelected}
            onSelectAll={() => void toggleAllFiltered()}
            onClear={() => {
              setSelectedIds([]);
              setAllSelected(false);
            }}
            busy={resultsUnavailable}
          >
            <Select
              aria-label="Applicant bulk action"
              disabled={resultsUnavailable}
              value=""
              onChange={(e) => setBulkAction(e.target.value)}
            >
              <option value="">Choose bulk action…</option>
              {[
                ...(talent ? [["screening", "Return to Screening"]] : []),
                ["proceed", "Move to next stage"],
                ["reject", "Reject"],
                ["withdraw", "Withdraw"],
                ["talent", "Move to talent pool"],
                ["assign", "Assign hiring need"],
                ["status", "Change status"],
                ["note", "Add note"],
                ["export", "Export selected"],
                ["delete", "Delete"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {dataset === "real" && (
              <ApplicantReprocess
                ids={selectedIds}
                disabled={resultsUnavailable}
              />
            )}
          </BulkActions>
        )}
        {listLoading && !rows.length ? (
          <LoadingSkeleton />
        ) : rows.length ? (
          <SelectionSurface
            className={`applications-table ${selectedIds.length ? "is-selecting" : ""}`}
            disabled={resultsUnavailable || !canManage(state.currentUser)}
            onSelect={(id) => {
              setAllSelected(false);
              setSelectedIds((ids) => [...new Set([...ids, id])]);
            }}
          >
            <Table>
              <thead>
                <tr>
                  {[
                    ...(selectedIds.length ? ["Select"] : []),
                    "Applicant",
                    "Role / urgency",
                    "Qualifications",
                    talent ? "Experience" : "Stage",
                    "Status",
                    tab === "Hired" ? "Hired date" : "Last activity",
                    "",
                  ].map((c, i) => (
                    <th
                      key={i}
                      className={
                        c === "Select"
                          ? "application-selection-cell"
                          : undefined
                      }
                    >
                      {c === "Select" ? (
                        <span className="sr-only">{c}</span>
                      ) : (
                        c
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr
                    key={a.id}
                    data-record-id={a.id}
                    aria-selected={selectedIds.includes(a.id)}
                  >
                    {!!selectedIds.length && (
                      <td className="application-selection-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select ${applicantDisplayName(a)}`}
                          checked={selectedIds.includes(a.id)}
                          disabled={
                            resultsUnavailable || !canManage(state.currentUser)
                          }
                          onChange={(e) => {
                            setAllSelected(false);
                            setSelectedIds((ids) =>
                              e.target.checked
                                ? [...new Set([...ids, a.id])]
                                : ids.filter((id) => id !== a.id),
                            );
                          }}
                        />
                      </td>
                    )}
                    <td>
                      <Link
                        className="applicant-cell"
                        href={profileHref(a.id)}
                        prefetch={false}
                      >
                        <ApplicantCard
                          name={applicantDisplayName(a)}
                          reference={a.id}
                        />
                      </Link>
                      {a.isDemo && <Badge tone="amber">DEMO</Badge>}
                      {a.queueState === "Queued" && <Badge>Queued</Badge>}
                      {a.retentionExpiresAt &&
                        ["outside_live_queue", "terminal"].includes(
                          a.retentionCategory || "",
                        ) && (
                          <small className="retention-inline">
                            {a.retentionCategory === "outside_live_queue"
                              ? "Outside live queue"
                              : "Status retention pending"}{" "}
                            — permanent cleanup eligible{" "}
                            {daysUntil(Date.parse(a.retentionExpiresAt)) > 0
                              ? `in ${daysUntil(Date.parse(a.retentionExpiresAt))} days`
                              : "now"}
                          </small>
                        )}
                      {talent && !a.talentPoolExpiredAt && (
                        <small className="retention-inline">
                          {talentRetentionWarning(a)}
                        </small>
                      )}
                    </td>
                    <td className="application-role-cell">
                      <strong className="application-role">{a.position}</strong>
                      <small className="cell-secondary">{a.location}</small>
                      {state.hiringNeeds.find((n) => n.id === a.hiringNeedId)
                        ?.urgency && (
                        <span className="application-urgency">
                          <StatusBadge
                            status={
                              state.hiringNeeds.find(
                                (n) => n.id === a.hiringNeedId,
                              )!.urgency
                            }
                          />
                        </span>
                      )}
                    </td>
                    <td className="application-qualification-cell">
                      <span
                        className="qualification-summary"
                        title={a.screening.outcome}
                      >
                        {a.screening.criteria.length
                          ? `${a.screening.criteria.filter((c) => c.result === "Met").length}/${a.screening.criteria.length} met`
                          : "Not assessed"}
                      </span>
                      <small className="cell-secondary">
                        {a.screening.criteria.length
                          ? `${
                              a.screening.criteria.filter(
                                (c) => c.result === "Unclear",
                              ).length
                            } unclear`
                          : "Assign a position set"}
                      </small>
                    </td>
                    <td>
                      {talent ? (
                        `${a.applicant.experience || "Unverified"} years`
                      ) : (
                        <StatusBadge status={a.stage} />
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={
                          tab === "Hired"
                            ? a.employment?.status || "Active"
                            : a.status
                        }
                      />
                    </td>
                    <td>
                      {formatDate(
                        tab === "Hired"
                          ? a.hiredAt || a.lastActivity
                          : ["All applications", "Queued"].includes(tab) &&
                              a.gmailActivityAt
                            ? a.gmailActivityAt
                            : a.lastActivity,
                        state.preferences,
                        Boolean(a.gmailActivityAt) &&
                          ["All applications", "Queued"].includes(tab),
                      )}
                      {a.gmailActivityAt &&
                        ["All applications", "Queued"].includes(tab) && (
                          <small className="cell-secondary">
                            Gmail thread updated
                          </small>
                        )}
                    </td>
                    <td>
                      <ActionMenu
                        label={`Actions for ${applicantDisplayName(a)}`}
                        items={[
                          {
                            label: selectedIds.includes(a.id)
                              ? "Deselect record"
                              : "Select record",
                            onClick: () => {
                              setAllSelected(false);
                              setSelectedIds((ids) =>
                                ids.includes(a.id)
                                  ? ids.filter((id) => id !== a.id)
                                  : [...ids, a.id],
                              );
                            },
                            disabled:
                              resultsUnavailable ||
                              !canManage(state.currentUser),
                          },
                          ...(a.status === "Talent Pool"
                            ? [
                                {
                                  label: "Return to Screening",
                                  onClick: () => setIndividualScreeningId(a.id),
                                  disabled:
                                    !canManage(state.currentUser) ||
                                    resultsUnavailable,
                                },
                              ]
                            : []),
                          {
                            label: "View Applicant",
                            onClick: () => router.push(profileHref(a.id)),
                          },
                          {
                            label: "Edit Applicant",
                            onClick: () => setEditing(a),
                            disabled: !canEdit(state.currentUser, a),
                          },
                          {
                            label: "Delete Applicant",
                            onClick: () => setDeleting(a),
                            disabled: !canManage(state.currentUser),
                            danger: true,
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </SelectionSurface>
        ) : (
          <EmptyState
            title={
              q
                ? `No applicants found for “${q}”`
                : talent
                  ? "No talent pool candidates"
                  : "No applications found"
            }
            description={
              q ||
              position ||
              location ||
              status ||
              stage ||
              screening ||
              urgency ||
              date ||
              needFilter ||
              experience
                ? "Adjust the search or clear filters to see more applicants."
                : talent
                  ? "Candidates you save to the talent pool will appear here for future openings."
                  : total > 0
                    ? "No applicants match these filters. Clear filters to see all applications."
                    : "Import applications from Daily Joe Careers Gmail or add an applicant manually to get started."
            }
          />
        )}
        <div className="table-footer">
          <span>
            Showing {rows.length ? (currentPage - 1) * 20 + 1 : 0}–
            {Math.min(currentPage * 20, total)} of {total} applicants
          </span>
          <div className="pagination-controls" aria-label="Application pages">
            <Button
              variant="secondary"
              disabled={listLoading || currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              ← Previous
            </Button>
            {Array.from(
              { length: Math.min(pageCount, 7) },
              (_, index) =>
                Math.max(0, Math.min(currentPage - 4, pageCount - 7)) + index,
            ).map((i) => (
              <Button
                key={i}
                variant={currentPage === i + 1 ? "primary" : "ghost"}
                aria-current={currentPage === i + 1 ? "page" : undefined}
                aria-label={`Page ${i + 1}`}
                disabled={listLoading}
                onClick={() => setPage(i + 1)}
              >
                {i + 1}
              </Button>
            ))}
            <Button
              variant="secondary"
              disabled={listLoading || currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next →
            </Button>
          </div>
          <Badge>
            {dataset === "demo" ? "Demo workspace" : "Live workspace"}
          </Badge>
        </div>
      </Card>
      {bulkAction && (
        <ApplicantBulkDialog
          action={bulkAction}
          ids={selectedIds}
          allFiltered={allSelected}
          filters={selectionFilters}
          onClose={() => setBulkAction("")}
          onDone={() => {
            setBulkAction("");
            setSelectedIds([]);
            setAllSelected(false);
            setReload((v) => v + 1);
          }}
        />
      )}
      {individualScreeningId && (
        <ApplicantBulkDialog
          action="screening"
          ids={[individualScreeningId]}
          allFiltered={false}
          filters={selectionFilters}
          onClose={() => setIndividualScreeningId("")}
          onDone={() => {
            setIndividualScreeningId("");
            setSelectedIds([]);
            setAllSelected(false);
            setReload((v) => v + 1);
          }}
        />
      )}
      {editing && (
        <ApplicantEditor
          application={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteApplicantDialog
          application={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
