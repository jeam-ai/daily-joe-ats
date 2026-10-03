"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BriefcaseBusiness,
  ContactRound,
  LoaderCircle,
  PackageCheck,
  Search,
  UsersRound,
} from "lucide-react";
import type { Application } from "@/types";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { Card, EmptyState, HelpTip, Input, LoadingSkeleton } from "./ui";

function includesQuery(values: Array<string | undefined>, query: string) {
  return values.some((value) => value?.toLowerCase().includes(query));
}

export function GlobalSearchResults() {
  const { state, dataset } = useApp();
  const params = useSearchParams();
  const query = (params.get("q") || "").trim().toLowerCase();
  const [results, setResults] = useState<{
    applications: Application[];
    employees: Application[];
    applicantCount: number;
    employeeCount: number;
  }>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setResults(undefined);
    setError("");
    setLoading(!!query);
    if (!query) return () => abort.abort();
    const timer = setTimeout(() => {
      const filters = new URLSearchParams({ q: query, limit: "8" });
      Promise.all([
        requestJson<{ applications: Application[]; total: number }>(
          `/api/applications?${filters}`,
          { signal: abort.signal },
        ),
        requestJson<{ applications: Application[]; total: number }>(
          `/api/applications?${filters}&tab=Hired`,
          { signal: abort.signal },
        ),
      ])
        .then(([apps, employees]) => {
          if (!abort.signal.aborted)
            setResults({
              applications: apps.applications,
              employees: employees.applications,
              applicantCount: apps.total,
              employeeCount: employees.total,
            });
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, dataset, state?.revision]);
  if (!state) return <LoadingSkeleton />;
  const applications = results?.applications || [];
  const employees = results?.employees || [];
  const needs = query
    ? state.hiringNeeds.filter((need) =>
        includesQuery([need.position, need.location], query),
      )
    : [];
  const issuance = query
    ? (state.issuance || []).filter((record) =>
        includesQuery(
          [
            record.employeeName,
            record.employeeId,
            record.position,
            record.branch,
            record.item,
          ],
          query,
        ),
      )
    : [];
  const groups = [
    {
      label: "Applicants",
      icon: UsersRound,
      count: results?.applicantCount || 0,
      allHref: `/applications?q=${encodeURIComponent(query)}`,
      href: (id: string) => `/applications/${id}`,
      items: applications.map((application) => ({
        id: application.id,
        title: application.applicant.name,
        detail: `${application.position} · ${application.location}`,
      })),
    },
    {
      label: "Employees",
      icon: ContactRound,
      count: results?.employeeCount || 0,
      allHref: `/applications?q=${encodeURIComponent(query)}&status=Hired`,
      href: (id: string) => `/applications/${id}`,
      items: employees.map((employee) => ({
        id: employee.id,
        title: employee.applicant.name,
        detail: `${employee.position} · ${employee.location}`,
      })),
    },
    {
      label: "Hiring needs",
      icon: BriefcaseBusiness,
      count: needs.length,
      allHref: "/hiring-needs",
      href: () => "/hiring-needs",
      items: needs.map((need) => ({
        id: need.id,
        title: need.position,
        detail: `${need.location} · ${need.status}`,
      })),
    },
    {
      label: "Issued items",
      icon: PackageCheck,
      count: issuance.length,
      allHref: "/issuance",
      href: () => "/issuance",
      items: issuance.map((record) => ({
        id: record.id,
        title: record.employeeName,
        detail: `${record.item} · ${record.branch || "Branch not recorded"}`,
      })),
    },
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return (
    <div className="workspace-page global-search-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">FIND WHAT YOU NEED</div>
          <h1>Search HR hub</h1>
          <p>
            Search workspace records by person, email, position, branch, or
            issued item.
          </p>
        </div>
        <HelpTip>
          Search returns only records available to your authorized HR workspace.
          It does not search resume text or deleted applicant data.
        </HelpTip>
      </div>
      <form action="/search" className="hub-search-form">
        <Search size={19} />
        <Input
          name="q"
          defaultValue={params.get("q") || ""}
          placeholder="Employee, applicant, email, position, branch…"
          autoFocus
        />
        <button type="submit" disabled={loading}>
          Search
        </button>
      </form>
      {loading && (
        <p className="search-feedback" role="status">
          <LoaderCircle size={16} className="loading-spinner" /> Searching
          applicants…
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!query ? (
        <EmptyState
          title="Search the HR hub"
          description="Try an applicant name, email, employee ID, position, location, or issued item."
        />
      ) : loading || error ? null : !total ? (
        <EmptyState
          title={`No records found for “${params.get("q") || ""}”`}
          description="Try a shorter name, different spelling, or another position or branch."
        />
      ) : (
        <div className="search-results-grid">
          {groups
            .filter((group) => group.count)
            .map((group) => {
              const Icon = group.icon;
              return (
                <Card className="search-result-group" key={group.label}>
                  <div className="section-heading">
                    <div className="search-result-title">
                      <Icon size={18} />
                      <h2>{group.label}</h2>
                    </div>
                    <strong>{group.count}</strong>
                  </div>
                  {group.items.slice(0, 8).map((item) => (
                    <Link
                      key={item.id}
                      className="search-result-row"
                      href={group.href(item.id)}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </span>
                      <span>Open</span>
                    </Link>
                  ))}
                  {group.count > 8 && (
                    <Link className="text-link" href={group.allHref}>
                      View all {group.count} results
                    </Link>
                  )}
                </Card>
              );
            })}
        </div>
      )}
    </div>
  );
}
