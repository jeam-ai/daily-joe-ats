"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  ArrowUpRight,
  Download,
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
import { isActive } from "@/lib/recruitment";
import type { Application } from "@/types";
import {
  canManage,
  canEdit,
  activeIntake,
  INTAKE_QUEUE_LIMIT,
} from "@/lib/data-policy";
import { requestJson, downloadFile } from "@/lib/client-request";
import { ApplicantEditor, DeleteApplicantDialog } from "./applicant-management";
import { ActionMenu } from "./action-menu";
import { formatDate, monthKey } from "@/lib/dates";
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
  const [position, setPosition] = useState("");
  const [location, setLocation] = useState("");
  const [screening, setScreening] = useState("");
  const [date, setDate] = useState(
    params.get("month") === "current" ? "month" : "",
  );
  const [experience, setExperience] = useState("");
  const [tab, setTab] = useState(
    params.get("view") === "interviews" ? "Interviews" : "Active",
  );
  const [page, setPage] = useState(1);
  const [employmentStatus, setEmploymentStatus] = useState("");
  const [urgency, setUrgency] = useState("");
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    setQ(params.get("q") || "");
    setNeedFilter(params.get("need") || "");
    setStatus(params.get("status") || "");
    setStage(params.get("stage") || "");
    setPage(1);
  }, [params]);
  const [listing, setListing] = useState<{
      applications: Application[];
      total: number;
      page: number;
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
    talent: talent ? "1" : "0",
    since:
      date === "week"
        ? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
        : date === "month"
          ? new Date(
              new Date().getFullYear(),
              new Date().getMonth(),
              1,
            ).toISOString()
          : "",
  }).toString();
  useEffect(() => {
    const abort = new AbortController();
    setListLoading(true);
    setListError("");
    const timer = setTimeout(() => {
      requestJson<{ applications: Application[]; total: number; page: number }>(
        `/api/applications?${queryParams}`,
        { signal: abort.signal },
      )
        .then((r) => {
          if (!abort.signal.aborted) setListing(r);
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
  }, [queryParams, dataset, state?.revision, reload]);
  if (!state) return <LoadingSkeleton />;
  const selectedNeed = state.hiringNeeds.find((need) => need.id === needFilter);
  const rows = listing?.applications || [],
    total = listing?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / 20)),
    currentPage = listing?.page || page,
    visible = rows;
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
      <div className="page-heading">
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
      <Card className="workspace-card">
        {state.intakePaused && dataset === "real" && (
          <p className="warning-banner">
            Gmail intake is paused for this fresh workspace. When you are ready,
            reconnect Gmail and resume intake in Settings → Appearance &
            Preferences.
          </p>
        )}
        <StageLegend compact />
        {!talent && dataset === "real" && (
          <p className="padded fine-print">
            Latest 100 active applications ·{" "}
            {state.applications.filter(activeIntake).length} active ·{" "}
            {state.applications.filter((a) => a.queueState === "Queued").length}{" "}
            queued. New applications enter the active window; older applications
            remain available in Queued. Intake retains up to{" "}
            {INTAKE_QUEUE_LIMIT} eligible applications; closed records remain in
            history.
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
              placeholder="Search name or email"
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
        {listError ? (
          <div className="error-banner" role="alert">
            {listError}
            <Button variant="secondary" onClick={() => setReload((v) => v + 1)}>
              Retry
            </Button>
          </div>
        ) : listLoading ? (
          <LoadingSkeleton />
        ) : rows.length ? (
          <Table>
            <thead>
              <tr>
                {[
                  "Applicant",
                  "Role / urgency",
                  "Qualifications",
                  talent ? "Experience" : "Stage",
                  "Status",
                  tab === "Hired" ? "Hired date" : "Last activity",
                  "",
                ].map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link
                      className="applicant-cell"
                      href={`/applications/${a.id}`}
                    >
                      <ApplicantCard name={a.applicant.name} reference={a.id} />
                    </Link>
                    {a.isDemo && <Badge tone="amber">DEMO</Badge>}
                    {a.queueState === "Queued" && <Badge>Queued</Badge>}
                  </td>
                  <td>
                    {a.position}
                    <small className="cell-secondary">{a.location}</small>
                    {state.hiringNeeds.find((n) => n.id === a.hiringNeedId)
                      ?.urgency && (
                      <>
                        <br />
                        <StatusBadge
                          status={
                            state.hiringNeeds.find(
                              (n) => n.id === a.hiringNeedId,
                            )!.urgency
                          }
                        />
                      </>
                    )}
                  </td>
                  <td>
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
                        : "Qualifications not configured"}
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
                        : a.lastActivity,
                      state.preferences,
                    )}
                  </td>
                  <td>
                    <ActionMenu
                      label={`Actions for ${a.applicant.name}`}
                      items={[
                        {
                          label: "View Applicant",
                          onClick: () => router.push(`/applications/${a.id}`),
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
        ) : (
          <EmptyState
            title={
              talent ? "No talent pool candidates" : "No applications found"
            }
            description={
              talent
                ? "Candidates you save to the talent pool will appear here for future openings."
                : state.applications.length
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
              disabled={currentPage <= 1}
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
                onClick={() => setPage(i + 1)}
              >
                {i + 1}
              </Button>
            ))}
            <Button
              variant="secondary"
              disabled={currentPage >= pageCount}
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
