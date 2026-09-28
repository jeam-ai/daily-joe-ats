"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BriefcaseBusiness, ContactRound, PackageCheck, Search, UsersRound } from "lucide-react";
import { useApp } from "./provider";
import { Card, EmptyState, HelpTip, Input, LoadingSkeleton } from "./ui";

function includesQuery(values: Array<string | undefined>, query: string) {
  return values.some((value) => value?.toLowerCase().includes(query));
}

export function GlobalSearchResults() {
  const { state } = useApp();
  const params = useSearchParams();
  const query = (params.get("q") || "").trim().toLowerCase();
  if (!state) return <LoadingSkeleton />;
  const applications = query
    ? state.applications.filter((application) => includesQuery([
        application.applicant.name,
        application.applicant.email,
        application.applicant.phone,
        application.position,
        application.location,
      ], query))
    : [];
  const employees = applications.filter((application) => application.status === "Hired" || application.stage === "Hired" || application.hiredAt);
  const needs = query ? state.hiringNeeds.filter((need) => includesQuery([need.position, need.location], query)) : [];
  const issuance = query ? (state.issuance || []).filter((record) => includesQuery([record.employeeName, record.employeeId, record.position, record.branch, record.item], query)) : [];
  const groups = [
    { label: "Applicants", icon: UsersRound, count: applications.length, href: (id: string) => `/applications/${id}`, items: applications.map((application) => ({ id: application.id, title: application.applicant.name, detail: `${application.position} · ${application.location}` })) },
    { label: "Employees", icon: ContactRound, count: employees.length, href: (id: string) => `/applications/${id}`, items: employees.map((employee) => ({ id: employee.id, title: employee.applicant.name, detail: `${employee.position} · ${employee.location}` })) },
    { label: "Hiring needs", icon: BriefcaseBusiness, count: needs.length, href: () => "/hiring-needs", items: needs.map((need) => ({ id: need.id, title: need.position, detail: `${need.location} · ${need.status}` })) },
    { label: "Issued items", icon: PackageCheck, count: issuance.length, href: () => "/issuance", items: issuance.map((record) => ({ id: record.id, title: record.employeeName, detail: `${record.item} · ${record.branch || "Branch not recorded"}` })) },
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return (
    <div className="workspace-page global-search-page">
      <div className="page-heading workspace-page-heading">
        <div><div className="eyebrow">FIND WHAT YOU NEED</div><h1>Search HR hub</h1><p>Search active workspace records by person, email, position, branch, or issued item.</p></div>
        <HelpTip>Search returns only records available to your authorized HR workspace. It does not search resume text or archived applicant data.</HelpTip>
      </div>
      <form action="/search" className="hub-search-form"><Search size={19}/><Input name="q" defaultValue={params.get("q") || ""} placeholder="Employee, applicant, email, position, branch…" autoFocus /><button type="submit">Search</button></form>
      {!query ? <EmptyState title="Search the HR hub" description="Try an applicant name, email, employee ID, position, location, or issued item." /> : !total ? <EmptyState title="No matching records" description="Try a shorter name, different spelling, or another position or branch." /> : <div className="search-results-grid">{groups.filter((group) => group.count).map((group) => { const Icon = group.icon; return <Card className="search-result-group" key={group.label}><div className="section-heading"><div className="search-result-title"><Icon size={18}/><h2>{group.label}</h2></div><strong>{group.count}</strong></div>{group.items.slice(0, 8).map((item) => <Link key={item.id} className="search-result-row" href={group.href(item.id)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><span>Open</span></Link>)}</Card>})}</div>}
    </div>
  );
}
