"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, ClipboardList, UsersRound } from "lucide-react";
import { useApp } from "./provider";
import {
  Badge,
  Card,
  EmptyState,
  HelpTip,
  LoadingSkeleton,
  MetricCard,
  ProgressBar,
  Table,
  Tabs,
  Field,
  Input,
  Select,
} from "./ui";
import { formatDate } from "@/lib/dates";
import { BulkIssuance } from "./bulk-issuance";
import { BulkActions } from "./bulk-actions";
import { requestJson } from "@/lib/client-request";
import { canManage } from "@/lib/data-policy";
import type { Application } from "@/types";

type PeopleView = "Directory" | "Requirements" | "Onboarding";

function isEmployee(status: string, stage: string, hiredAt?: string) {
  return status === "Hired" || stage === "Hired" || !!hiredAt;
}

export function PeopleOperations() {
  const { state, dataset } = useApp();
  const [completeEmployees, setCompleteEmployees] = useState<Application[]>();
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    setCompleteEmployees(undefined);
    setLoadError("");
    if (dataset === "real")
      requestJson<{ applications: Application[] }>(
        "/api/issuance?onboarding=1",
        { signal: abort.signal },
      )
        .then((r) => {
          if (!abort.signal.aborted) setCompleteEmployees(r.applications);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setLoadError(e.message);
        });
    return () => abort.abort();
  }, [dataset, state?.revision]);
  useEffect(() => setSelectedKeys([]), [query, branch, dataset]);
  const params = useSearchParams();
  const router = useRouter();
  const view = (params.get("view") || "Directory") as PeopleView;
  if (!state) return <LoadingSkeleton />;
  const allEmployees = (
    dataset === "real" ? completeEmployees || [] : state.applications
  )
    .filter(
      (application) =>
        !application.deletedAt &&
        isEmployee(application.status, application.stage, application.hiredAt),
    )
    .sort((a, b) =>
      (b.hiredAt || b.appliedAt).localeCompare(a.hiredAt || a.appliedAt),
    );
  const employees = allEmployees.filter(
    (a) =>
      (!branch || (a.assignedBranch || a.location) === branch) &&
      (!query ||
        `${a.applicant.name} ${a.applicant.email} ${a.position}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const employeeKeys = [
    ...new Set(
      employees
        .filter((a) => !a.employment || a.employment.status === "Active")
        .map((a) => `person:${a.applicant.id}`),
    ),
  ];
  const selected = selectedKeys.filter((key) => employeeKeys.includes(key));
  const selectEmployee = (a: Application) => (
    <input
      type="checkbox"
      aria-label={`Select ${a.applicant.name}`}
      checked={selected.includes(`person:${a.applicant.id}`)}
      disabled={
        dataset === "demo" ||
        !canManage(state.currentUser) ||
        (!!a.employment && a.employment.status !== "Active")
      }
      onChange={(e) =>
        setSelectedKeys((ids) =>
          e.target.checked
            ? [...new Set([...ids, `person:${a.applicant.id}`])]
            : ids.filter((id) => id !== `person:${a.applicant.id}`),
        )
      }
    />
  );
  const requirements = employees.flatMap((employee) =>
    employee.requirements.map((requirement) => ({ employee, requirement })),
  );
  const pending = requirements.filter(
    ({ requirement }) => requirement.status !== "Complete",
  );
  const issuance = state.issuance || [];
  const updateHref = (next: PeopleView) =>
    `/people?view=${encodeURIComponent(next)}`;

  return (
    <div className="workspace-page people-operations-page onboarding-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">HR OPERATIONS</div>
          <h1>Onboarding</h1>
          <p>
            Keep new hires, requirements, and issuance readiness together from
            confirmed hire through handover.
          </p>
        </div>
        <BulkIssuance employeeKeys={selected.length ? selected : undefined} />
      </div>
      <p className="workspace-heading-note people-help-note">
        This workspace uses confirmed hiring data; it does not create an
        employee record from an applicant automatically.
        <HelpTip>
          An employee appears here only after HR marks the applicant as Hired or
          records a hire date.
        </HelpTip>
      </p>
      <div className="metrics-grid people-summary">
        <MetricCard
          label="New hires"
          value={employees.length}
          note="Confirmed hires ready for HR handover"
          icon={<UsersRound size={20} />}
          tone="featured"
        />
        <MetricCard
          label="Requirements pending"
          value={pending.length}
          note="Submitted requirements not yet complete"
          icon={<ClipboardList size={20} />}
          tone="metric-review"
        />
        <MetricCard
          label="Onboarding complete"
          value={
            employees.filter(
              (employee) => employee.onboardingStatus === "Completed",
            ).length
          }
          note="HR recorded onboarding as complete"
          icon={<CheckCircle2 size={20} />}
          tone="hired"
        />
      </div>
      <Card className="people-workspace">
        <div className="people-workspace-toolbar">
          <Tabs
            items={["Directory", "Requirements", "Onboarding"]}
            value={view}
            onChange={(next) => router.replace(updateHref(next as PeopleView))}
          />
          <HelpTip>
            Open an employee’s application to update requirement evidence,
            onboarding status, or the hiring decision.
          </HelpTip>
        </div>
        <div className="filter-bar">
          <Field label="Search employees">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, email, or position"
            />
          </Field>
          <Field label="Branch">
            <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">All branches</option>
              {[
                ...new Set(
                  allEmployees
                    .map((a) => a.assignedBranch || a.location)
                    .filter(Boolean),
                ),
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </Field>
        </div>
        {loadError && (
          <p className="error-banner" role="alert">
            {loadError}
          </p>
        )}
        {dataset === "real" && !completeEmployees && !loadError && (
          <p role="status">Loading employees…</p>
        )}
        {canManage(state.currentUser) && dataset === "real" && (
          <BulkActions
            count={selected.length}
            total={employeeKeys.length}
            allSelected={
              !!selected.length && selected.length === employeeKeys.length
            }
            onSelectAll={() =>
              setSelectedKeys(
                selected.length === employeeKeys.length ? [] : employeeKeys,
              )
            }
            onClear={() => setSelectedKeys([])}
          >
            <BulkIssuance employeeKeys={selected} />
          </BulkActions>
        )}
        {dataset === "real" && !completeEmployees && !loadError ? (
          <LoadingSkeleton />
        ) : !employees.length ? (
          <EmptyState
            title={
              query || branch
                ? "No employees match the current filters"
                : "No employee records yet"
            }
            description={
              query || branch
                ? "Adjust the employee search or branch filter."
                : "Employees appear here after HR confirms an applicant as hired."
            }
          />
        ) : view === "Directory" ? (
          <Table>
            <thead>
              <tr>
                <th>Select</th>
                <th>Employee</th>
                <th>Position / branch</th>
                <th>Hired</th>
                <th>Onboarding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td>{selectEmployee(employee)}</td>
                  <td>
                    <strong>{employee.applicant.name}</strong>
                    <small className="cell-secondary">
                      {employee.applicant.email}
                    </small>
                  </td>
                  <td>
                    {employee.position}
                    <small className="cell-secondary">
                      {employee.assignedBranch ||
                        employee.location ||
                        "Location not recorded"}
                    </small>
                  </td>
                  <td>
                    {formatDate(
                      employee.hiredAt || employee.appliedAt,
                      state.preferences,
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        employee.onboardingStatus === "Completed"
                          ? "green"
                          : "blue"
                      }
                    >
                      {employee.onboardingStatus}
                    </Badge>
                  </td>
                  <td>
                    <Link
                      className="text-link"
                      href={`/applications/${employee.id}`}
                    >
                      Open record
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : view === "Requirements" ? (
          requirements.length ? (
            <Table>
              <thead>
                <tr>
                  <th>Select employee</th>
                  <th>Employee</th>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Deadline</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requirements.map(({ employee, requirement }) => (
                  <tr key={`${employee.id}-${requirement.id}`}>
                    <td>{selectEmployee(employee)}</td>
                    <td>
                      <strong>{employee.applicant.name}</strong>
                      <small className="cell-secondary">
                        {employee.position} ·{" "}
                        {employee.assignedBranch || employee.location}
                      </small>
                    </td>
                    <td>{requirement.name}</td>
                    <td>
                      <Badge
                        tone={
                          requirement.status === "Complete"
                            ? "green"
                            : requirement.status === "Needs Correction"
                              ? "amber"
                              : "blue"
                        }
                      >
                        {requirement.status}
                      </Badge>
                    </td>
                    <td>
                      {requirement.date
                        ? formatDate(requirement.date, state.preferences)
                        : "No deadline"}
                    </td>
                    <td>
                      <Link
                        className="text-link"
                        href={`/applications/${employee.id}`}
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState
              title="No employee requirements recorded"
              description="Requirement monitoring starts once HR adds requirements to a hired employee’s record."
            />
          )
        ) : (
          <div className="onboarding-grid">
            {employees.map((employee) => {
              const total = employee.requirements.length;
              const complete = employee.requirements.filter(
                (item) => item.status === "Complete",
              ).length;
              const employeeIssuance = issuance.filter(
                (item) =>
                  item.employeeName.trim().toLowerCase() ===
                  employee.applicant.name.trim().toLowerCase(),
              );
              const uniformIssued = employeeIssuance.some(
                (item) =>
                  item.category === "Uniform" && item.status === "Issued",
              );
              const kitIssued = employeeIssuance.some(
                (item) =>
                  item.category === "Welcome Kit" && item.status === "Issued",
              );
              const completedChecks = [
                employee.stage === "Hired",
                total > 0 && complete === total,
                uniformIssued,
                kitIssued,
                employee.onboardingStatus === "Completed",
              ].filter(Boolean).length;
              const possibleChecks = 5;
              return (
                <Card className="onboarding-card" key={employee.id}>
                  <label className="checkbox-label">
                    {selectEmployee(employee)} Select employee
                  </label>
                  <div className="section-heading">
                    <div>
                      <h2>{employee.applicant.name}</h2>
                      <p>
                        {employee.position} ·{" "}
                        {employee.assignedBranch || employee.location}
                      </p>
                    </div>
                    <Badge>
                      {Math.round((completedChecks / possibleChecks) * 100)}%
                    </Badge>
                  </div>
                  <ProgressBar
                    value={Math.round((completedChecks / possibleChecks) * 100)}
                  />
                  <div className="onboarding-checks">
                    <span>
                      {employee.stage === "Hired" ? "✓" : "○"} Hire recorded
                    </span>
                    <span>
                      {total ? `${complete}/${total}` : "—"} Requirements
                    </span>
                    <span>{uniformIssued ? "✓" : "○"} Uniform</span>
                    <span>{kitIssued ? "✓" : "○"} Welcome kit</span>
                    <span>
                      {employee.onboardingStatus === "Completed" ? "✓" : "○"}{" "}
                      Onboarding
                    </span>
                  </div>
                  <p className="fine-print">
                    System account and branch assignment are shown only when
                    those fields are recorded in the employee profile.
                  </p>
                  <Link
                    className="text-link"
                    href={`/applications/${employee.id}`}
                  >
                    Open onboarding record
                  </Link>
                </Card>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
