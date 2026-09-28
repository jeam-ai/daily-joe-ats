"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Download,
  ChartNoAxesCombined,
  UsersRound,
  UserCheck,
  Bookmark,
} from "lucide-react";
import { useApp } from "./provider";
import { Button, Card, Select, Badge, EmptyState, Field, HelpTip, Input, LoadingSkeleton, Modal } from "./ui";
import { ReportDetails } from "./report-details";
import { requestJson } from "@/lib/client-request";
import type { RecruitmentReport, ReportBucket } from "@/types/reports";
export function Reports() {
  const { state, dataset, notify, saving, update } = useApp();
  const params = useSearchParams();
  const [range, setRange] = useState(params.get("range") || "all");
  const [savingView, setSavingView] = useState(false);
  const [report, setReport] = useState<RecruitmentReport | null>(null);
  const [reportError, setReportError] = useState("");
  const [expandedGroups, setExpandedGroups] = useState({
    position: false,
    location: false,
  });
  useEffect(() => {
    const abort = new AbortController();
    setReport(null);
    setReportError("");
    requestJson<RecruitmentReport>(`/api/reports/recruitment?range=${range}`, {
      signal: abort.signal,
    })
      .then(setReport)
      .catch((error) => {
        if (!abort.signal.aborted) setReportError((error as Error).message);
      });
    return () => abort.abort();
  }, [range, dataset, state?.revision]);
  if (!state) return <LoadingSkeleton />;
  const data = report;
  const group = (key: "position" | "location" | "stage" | "status") =>
    data?.groups[key] || [];
  async function saveView(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") || "").trim();
    if (!name) return;
    const saved = await update((workspace) => ({
      ...workspace,
      savedReports: [
        ...(workspace.savedReports || []),
        {
          id: crypto.randomUUID(),
          name,
          scope: "Recruitment" as const,
          href: `/reports?range=${encodeURIComponent(range)}`,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    if (saved) setSavingView(false);
  }
  function exportReport() {
    const rows = [
      ["Dimension", "Category", "Count"],
      ...(["position", "location", "stage", "status"] as const).flatMap((k) =>
        group(k).map(({ name, count }) => [k, name, String(count)]),
      ),
    ];
    const text = rows
      .map((r) =>
        r
          .map(
            (v) =>
              `"${(/^[=+@\-\t\r]/.test(v) ? "\u0027" + v : v).replaceAll('"', '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "Daily-Joe-Careers-Recruitment-Report.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Recruitment report downloaded.");
  }
  const months = (data?.months || []).map(({ key, count }) => ({
    label: new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "long",
    }),
    count,
  }));
  return (
    <div className="workspace-page reports-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">THE BIGGER PICTURE</div>
          <h1>Reports</h1>
          <p>
            Counts cover the selected period, including retained history. The
            500-item live queue is a separate working view.
          </p>
        </div>
        <div className="workspace-heading-side">
          <span className="workspace-heading-context">
            Counts-only recruitment history
          </span>
          <div className="inline-actions">
            <Select
              aria-label="Report period"
              value={range}
              onChange={(e) => setRange(e.target.value)}
            >
              <option value="all">All time</option>
              <option value="30">Last 30 days</option>
              <option value="7">Last 7 days</option>
            </Select>
            <Button
              variant="secondary"
              disabled={dataset === "demo" || !data?.total}
              title={
                dataset === "demo"
                  ? "Exit Demo to export production reports"
                  : undefined
              }
              onClick={exportReport}
            >
              <Download size={16} />
              Export report
            </Button>
            <Button
              variant="secondary"
              disabled={dataset === "demo" || saving}
              onClick={() => setSavingView(true)}
            >
              <Bookmark size={16} />
              Save view
            </Button>
          </div>
        </div>
      </div>
      <p className="workspace-heading-note">
        Review recruitment trends without exposing applicant data beyond the
        workspace where HR needs it.
        <HelpTip>
          A saved view stores its name and filters only. It never saves applicant rows or personal information into the report.
        </HelpTip>
      </p>
      {(state.savedReports || []).length > 0 && (
        <Card className="saved-reports-card">
          <div className="section-heading"><div><span className="section-kicker">Reusable filters</span><h2>Saved reports</h2></div><Badge>{state.savedReports!.length}</Badge></div>
          <div className="saved-report-list">
            {state.savedReports!.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((saved) => (
              <Link className="saved-report-link" href={saved.href} key={saved.id}><Bookmark size={15}/><span><strong>{saved.name}</strong><small>{saved.scope}</small></span><span>Run</span></Link>
            ))}
          </div>
        </Card>
      )}
      {reportError ? (
        <EmptyState title="Report unavailable" description={reportError} />
      ) : !data ? (
        <LoadingSkeleton />
      ) : !data.total ? (
        <EmptyState
          title="No reports for this period"
          description="Select a wider date range."
        />
      ) : (
        <>
          <div className="report-metrics reports-summary">
            {[
              [
                range === "all"
                  ? "All-time applications"
                  : "Applications in period",
                data.total,
                UsersRound,
              ],
              ["Hired", data.hired, UserCheck],
              ["Talent pool", data.talentPool, Bookmark],
              [
                "Interview pipeline",
                data.interviewPipeline,
                ChartNoAxesCombined,
              ],
            ].map(([label, count, Icon]) => {
              const I = Icon as typeof UsersRound;
              return (
                <Card key={String(label)} className="report-metric">
                  <I size={22} />
                  <strong>{String(count)}</strong>
                  <span>{String(label)}</span>
                </Card>
              );
            })}
          </div>
          <div className="reports-grid">
            <Card className="padded report-panel report-panel-featured">
              <div className="section-heading">
                <h2>Applications by month</h2>
                <Badge>
                  {dataset === "demo" ? "Demo records" : "Saved applications"}
                </Badge>
              </div>
              <div
                className="bar-chart"
                role="img"
                aria-label={months
                  .map((m) => `${m.label}: ${m.count}`)
                  .join(", ")}
              >
                {months.map((m, i) => (
                  <div key={i}>
                    <strong>{m.count}</strong>
                    <i
                      style={{
                        height: `${Math.max(2, (m.count / Math.max(...months.map((m) => m.count), 1)) * 150)}px`,
                      }}
                    />
                    <span>{m.label}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="padded report-panel">
              <h2>Screening outcomes</h2>
              {["Meets Criteria", "Requires Review", "Criteria Not Met"].map(
                (s, i) => {
                  const count =
                    data.screening.find((item) => item.name === s)?.count || 0;
                  return (
                    <div className="report-bar" key={s}>
                      <div>
                        <span>{s}</span>
                        <strong>{count}</strong>
                      </div>
                      <div className={`report-track color-${i}`}>
                        <i
                          style={{ width: `${(count / data.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                },
              )}
              <p className="fine-print">
                Screening outcomes are advisory and do not determine HR
                decisions.
              </p>
            </Card>
            {(["position", "location", "stage", "status"] as const).map(
              (key) => {
                const buckets = group(key);
                const expandable = key === "position" || key === "location";
                const expanded = expandable && expandedGroups[key];
                const visible =
                  expandable && !expanded ? buckets.slice(0, 5) : buckets;
                return (
                  <Card className="padded report-panel" key={key}>
                    <h2>
                      {key === "stage"
                        ? "Interview & recruitment pipeline"
                        : key === "status"
                          ? "Application outcomes"
                          : `Applications by ${key}`}
                    </h2>
                    {visible.map(({ name, count }: ReportBucket) => (
                      <div className="report-bar" key={name}>
                        <div>
                          <span>{name}</span>
                          <strong>{count}</strong>
                        </div>
                        <div className="report-track">
                          <i
                            style={{ width: `${(count / data.total) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                    {expandable && buckets.length > 5 && (
                      <Button
                        variant="secondary"
                        className="report-group-toggle"
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedGroups((current) => ({
                            ...current,
                            [key]: !current[key],
                          }))
                        }
                      >
                        {expanded
                          ? "Show less"
                          : `Show all ${buckets.length} ${key === "position" ? "positions" : "locations"}`}
                      </Button>
                    )}
                  </Card>
                );
              },
            )}
          </div>
        </>
      )}
      {data && data.total > 0 && <ReportDetails data={data} />}
      {savingView && (
        <Modal title="Save report view" busy={saving} onClose={() => setSavingView(false)}>
          <form className="form-stack" onSubmit={saveView}>
            <Field label="Report name"><Input name="name" required autoFocus placeholder="Example: September recruitment summary" /></Field>
            <p className="fine-print">This saves the current report filter ({range === "all" ? "all time" : `last ${range} days`}) for quick reuse.</p>
            <div className="modal-actions"><Button type="button" variant="secondary" onClick={() => setSavingView(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save report"}</Button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
