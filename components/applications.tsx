"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
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
export function Applications({ talent = false }: { talent?: boolean }) {
  const { state } = useApp();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
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
    params.get("view") === "interviews" ? "Interviews" : "All applications",
  );
  const [page, setPage] = useState(1);
  const [urgency, setUrgency] = useState("");
  const [exporting, setExporting] = useState(false);
  if (!state) return <LoadingSkeleton />;
  const rows = state.applications.filter(
    (a) =>
      (talent ? a.status === "Talent Pool" : true) &&
      (!q ||
        `${a.applicant.name} ${a.applicant.email}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!params.get("need") || a.hiringNeedId === params.get("need")) &&
      (!urgency ||
        state.hiringNeeds.find((n) => n.id === a.hiringNeedId)?.urgency ===
          urgency) &&
      (!status || a.status === status) &&
      (!stage || a.stage === stage) &&
      (!position || a.position === position) &&
      (!location || a.location === location) &&
      (!screening || a.screening.outcome === screening) &&
      (!experience || a.applicant.experience >= Number(experience)) &&
      (!date ||
        (date === "month"
          ? new Date(talent ? a.talentPoolAddedAt || a.appliedAt : a.appliedAt)
              .toISOString()
              .slice(0, 7) === new Date().toISOString().slice(0, 7)
          : Date.now() -
              new Date(
                talent ? a.talentPoolAddedAt || a.appliedAt : a.appliedAt,
              ).getTime() <
            7 * 86400000)) &&
      (talent ||
        tab === "All applications" ||
        (tab === "Active" && isActive(a)) ||
        (tab === "Interviews" &&
          a.stage.includes("Interview") &&
          isActive(a)) ||
        (tab === "Pre-employment" && a.stage === "Requirements") ||
        (tab === "Onboarding" && a.stage === "Onboarding") ||
        (tab === "Hired" && a.status === "Hired")),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / 20));
  const currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * 20, currentPage * 20);
  function exportCsv() {
    setExporting(true);
    window.location.href = "/api/tracker";
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
        <Button variant="secondary" onClick={exportCsv} disabled={exporting}>
          <Download size={16} />
          {exporting
            ? "Preparing tracker…"
            : `Export ${talent ? "talent pool" : "applications"}`}
        </Button>
      </div>
      <Card className="workspace-card">
        <StageLegend compact />
        {!talent && (
          <Tabs
            items={[
              "All applications",
              "Active",
              "Interviews",
              "Pre-employment",
              "Onboarding",
              "Hired",
            ]}
            value={tab}
            onChange={setTab}
          />
        )}
        <div className="filter-bar">
          <div className="search-field">
            <Search size={17} />
            <Input
              aria-label="Search applications"
              placeholder="Search name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select
            aria-label="Position"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          >
            <option value="">All positions</option>
            {["Barista", "Team Leader", "Supervisor"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
          <Select
            aria-label="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
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
            onChange={(e) => setScreening(e.target.value)}
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
          {!talent && (
            <>
              <Select
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
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
                onChange={(e) => setStage(e.target.value)}
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
              onChange={(e) => setExperience(e.target.value)}
            >
              <option value="">Any experience</option>
              <option value="2">2+ years</option>
              <option value="4">4+ years</option>
            </Select>
          )}
          <Select
            aria-label={talent ? "Date added" : "Application date"}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          >
            <option value="">Any date</option>
            <option value="week">Last 7 days</option>
            <option value="month">This month</option>
          </Select>
          <button
            className="text-link"
            onClick={() => {
              setUrgency("");
              setPage(1);
              setQ("");
              setStatus("");
              setStage("");
              setPosition("");
              setLocation("");
              setScreening("");
              setDate("");
              setExperience("");
            }}
          >
            Clear filters
          </button>
          <span className="result-count">
            {rows.length} {talent ? "candidates" : "applications"}
          </span>
        </div>
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                {[
                  "Applicant",
                  "Position",
                  "Location",
                  talent ? "Date added" : "Applied",
                  "Screening",
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
                      <ApplicantCard
                        name={a.applicant.name}
                        reference={a.applicant.email}
                      />
                    </Link>
                  </td>
                  <td>
                    {a.position}
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
                  <td>{a.location}</td>
                  <td>
                    {new Date(
                      talent ? a.talentPoolAddedAt || a.appliedAt : a.appliedAt,
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td>
                    <StatusBadge status={a.screening.outcome} />
                  </td>
                  <td>
                    {talent ? (
                      `${a.applicant.experience || "Unverified"} years`
                    ) : (
                      <StatusBadge status={a.stage} />
                    )}
                  </td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td>
                    {new Date(
                      tab === "Hired"
                        ? a.hiredAt || a.lastActivity
                        : a.lastActivity,
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td>
                    <Link
                      className="icon-button"
                      aria-label={`Open ${a.applicant.name}`}
                      href={`/applications/${a.id}`}
                    >
                      <ArrowUpRight size={18} />
                    </Link>
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
          />
        )}
        <div className="table-footer">
          <span>
            Showing {rows.length ? (currentPage - 1) * 20 + 1 : 0}–
            {Math.min(currentPage * 20, rows.length)} of {rows.length}{" "}
            applicants
          </span>
          <Button
            variant="secondary"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            ← Previous
          </Button>
          {Array.from({ length: pageCount }, (_, i) => (
            <Button
              key={i}
              variant={currentPage === i + 1 ? "primary" : "ghost"}
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
          <Badge>Live workspace</Badge>
        </div>
      </Card>
    </>
  );
}
