"use client";
import { useState } from "react";
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
export function Reports() {
  const { state } = useApp();
  const [range, setRange] = useState("all");
  if (!state) return <LoadingSkeleton />;
  const apps = state.applications.filter(
    (a) =>
      range === "all" ||
      Date.now() - new Date(a.appliedAt).getTime() < Number(range) * 86400000,
  );
  const group = (key: "position" | "location" | "stage" | "status") =>
    Object.entries(
      apps.reduce(
        (acc, a) => ({ ...acc, [a[key]]: (acc[a[key]] || 0) + 1 }),
        {} as Record<string, number>,
      ),
    );
  function exportReport() {
    const rows = [
      ["Dimension", "Category", "Count"],
      ...(["position", "location", "stage", "status"] as const).flatMap((k) =>
        group(k).map(([v, n]) => [k, v, String(n)]),
      ),
    ];
    const text = rows
      .map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "daily-joe-recruitment-report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  const months = Array.from({ length: 6 }, (_, i) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - 5 + i);
    return {
      label: date.toLocaleDateString("en-US", { month: "short" }),
      count: apps.filter(
        (a) => a.appliedAt.slice(0, 7) === date.toISOString().slice(0, 7),
      ).length,
    };
  });
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
          <Button variant="secondary" onClick={exportReport}>
            <Download size={16} />
            Export report
          </Button>
        </div>
      </div>
      {!apps.length ? (
        <EmptyState
          title="No reports for this period"
          description="Select a wider date range."
        />
      ) : (
        <>
          <div className="report-metrics">
            {[
              ["Applications", apps.length, UsersRound],
              [
                "Hired",
                apps.filter((a) => a.status === "Hired").length,
                UserCheck,
              ],
              [
                "Talent pool",
                apps.filter((a) => a.status === "Talent Pool").length,
                Bookmark,
              ],
              [
                "Interview pipeline",
                apps.filter((a) => a.stage.includes("Interview")).length,
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
            <Card className="padded">
              <div className="section-heading">
                <h2>Applications by month</h2>
                <Badge>Imported records</Badge>
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
                  const count = apps.filter(
                    (a) => a.screening.outcome === s,
                  ).length;
                  return (
                    <div className="report-bar" key={s}>
                      <div>
                        <span>{s}</span>
                        <strong>{count}</strong>
                      </div>
                      <div className={`report-track color-${i}`}>
                        <i
                          style={{ width: `${(count / apps.length) * 100}%` }}
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
                  {group(key).map(([name, count]) => (
                    <div className="report-bar" key={name}>
                      <div>
                        <span>{name}</span>
                        <strong>{count}</strong>
                      </div>
                      <div className="report-track">
                        <i
                          style={{ width: `${(count / apps.length) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </Card>
              ),
            )}
          </div>
        </>
      )}
      <ReportDetails state={state} range={range} />
    </>
  );
}
