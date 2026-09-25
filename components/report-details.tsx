"use client";
import { Card, Table, StatusBadge } from "./ui";
import type { RecruitmentReport } from "@/types/reports";
export function ReportDetails({
  data,
}: {
  data: RecruitmentReport;
}) {
  const summaries = [
    ["Rejection reasons", data.details.rejectionReasons],
    ["Withdrawal reasons", data.details.withdrawalReasons],
    ["Application source", data.details.sources],
    ["Employment status", data.details.employment],
    ["Screening outcomes", data.details.screening],
    ["Interview outcomes", data.details.interviews],
  ] as [string, { name: string; count: number }[]][];
  return (
    <>
      <div className="report-metrics spaced">
        <Card className="padded">
          <h3>Average time to hire</h3>
          <h2>
            {data.averageDaysToHire !== null
              ? `${data.averageDaysToHire} days`
              : "No hires yet"}
          </h2>
          <p>Original application date to original hired date.</p>
        </Card>
        <Card className="padded">
          <h3>Hiring history retained</h3>
          <h2>
            {data.hireCount} {data.hireCount === 1 ? "hire" : "hires"}
          </h2>
          <p>Resignation and termination never erase a hire.</p>
        </Card>
      </div>
      <div className="needs-grid spaced">
        {summaries.map(([title, values]) => {
          return (
            <Card key={title}>
              <div className="card-heading">
                <h2>{title}</h2>
              </div>
              <div className="padded">
                {values.length ? (
                  values.map(({ name, count }) => (
                    <div className="key-value" key={name}>
                      <span>{name}</span>
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
            {data.hiringNeeds.map((n) => (
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
