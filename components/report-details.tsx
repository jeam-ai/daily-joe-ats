"use client";
import type { AppState } from "@/types";
import { Card, Table, StatusBadge } from "./ui";
export function ReportDetails({
  state,
  range,
}: {
  state: AppState;
  range: string;
}) {
  const apps = state.applications.filter(
    (a) =>
      range === "all" ||
      Date.now() - Date.parse(a.appliedAt) < Number(range) * 86400000,
  );
  if (!apps.length) return null;
  const hires = apps.filter((a) => a.hiredAt);
  const days = hires.map((a) =>
    Math.max(0, (Date.parse(a.hiredAt!) - Date.parse(a.appliedAt)) / 86400000),
  );
  const summaries = [
    [
      "Rejection reasons",
      apps
        .filter((a) => a.status === "Rejected")
        .map((a) => a.rejectionReason || "Not provided"),
    ],
    [
      "Withdrawal reasons",
      apps
        .filter((a) => a.status === "Withdrawn")
        .map((a) => a.withdrawalReason || "Not provided"),
    ],
    ["Application source", apps.map((a) => a.source || "Not recorded")],
    ["Employment status", hires.map((a) => a.employment?.status || "Active")],
    ["Screening outcomes", apps.map((a) => a.screening.outcome)],
    [
      "Interview outcomes",
      apps.flatMap((a) => a.interviews.map((i) => `${i.stage} · ${i.status}`)),
    ],
  ] as [string, string[]][];
  return (
    <>
      <div className="report-metrics spaced">
        <Card className="padded">
          <h3>Average time to hire</h3>
          <h2>
            {days.length
              ? `${Math.round(days.reduce((a, b) => a + b, 0) / days.length)} days`
              : "No hires yet"}
          </h2>
          <p>Original application date to original hired date.</p>
        </Card>
        <Card className="padded">
          <h3>Hiring history retained</h3>
          <h2>{hires.length} hires</h2>
          <p>Resignation and termination never erase a hire.</p>
        </Card>
      </div>
      <div className="needs-grid spaced">
        {summaries.map(([title, values]) => {
          const counts = Object.entries(
            values.reduce(
              (r, v) => ({ ...r, [v]: (r[v] || 0) + 1 }),
              {} as Record<string, number>,
            ),
          );
          return (
            <Card key={title}>
              <div className="card-heading">
                <h2>{title}</h2>
              </div>
              <div className="padded">
                {counts.length ? (
                  counts.map(([label, count]) => (
                    <div className="key-value" key={label}>
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </div>
                  ))
                ) : (
                  <p>No records in this period.</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="spaced">
        <div className="card-heading">
          <h2>Hiring fulfillment · all time</h2>
        </div>
        <Table>
          <thead>
            <tr>
              <th>Position / branch</th>
              <th>Urgency</th>
              <th>Filled</th>
              <th>Remaining</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {state.hiringNeeds.map((n) => (
              <tr key={n.id}>
                <td>
                  {n.position} · {n.location}
                </td>
                <td>
                  <StatusBadge status={n.urgency} />
                </td>
                <td>
                  {n.filled}/{n.slots}
                </td>
                <td>{Math.max(0, n.slots - n.filled)}</td>
                <td>{n.status}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
