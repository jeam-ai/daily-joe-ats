"use client";
import { useEffect, useState } from "react";
import {
  Download,
  ChartNoAxesCombined,
  UsersRound,
  UserCheck,
  Bookmark,
} from "lucide-react";
import { useApp } from "./provider";
import { Button, Card, Select, Badge, EmptyState, LoadingSkeleton } from "./ui";
import { ReportDetails } from "./report-details";
import { requestJson } from "@/lib/client-request";
import type { RecruitmentReport, ReportBucket } from "@/types/reports";
export function Reports() {
  const { state, dataset, notify } = useApp();
  const [range, setRange] = useState("all");
  const [report, setReport] = useState<RecruitmentReport | null>(null);
  const [reportError, setReportError] = useState("");
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
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE BIGGER PICTURE</div>
          <h1>Reports</h1>
          <p>Understand your pipeline. Plan your next steps.</p>
        </div>
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
        </div>
      </div>
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
          <div className="report-metrics">
            {[
              ["Applications", data.total, UsersRound],
              ["Hired", data.hired, UserCheck],
              ["Talent pool", data.talentPool, Bookmark],
              ["Interview pipeline", data.interviewPipeline, ChartNoAxesCombined],
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
            <Card className="padded">
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
            <Card className="padded">
              <h2>Screening outcomes</h2>
              {["Meets Criteria", "Requires Review", "Criteria Not Met"].map(
                (s, i) => {
                  const count = data.screening.find((item) => item.name === s)?.count || 0;
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
              (key) => (
                <Card className="padded" key={key}>
                  <h2>
                    {key === "stage"
                      ? "Interview & recruitment pipeline"
                      : key === "status"
                        ? "Application outcomes"
                        : `Applications by ${key}`}
                  </h2>
                  {group(key).map(({ name, count }: ReportBucket) => (
                    <div className="report-bar" key={name}>
                      <div>
                        <span>{name}</span>
                        <strong>{count}</strong>
                      </div>
                      <div className="report-track">
                        <i style={{ width: `${(count / data.total) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </Card>
              ),
            )}
          </div>
        </>
      )}
      {data && data.total > 0 && <ReportDetails data={data} />}
    </>
  );
}
