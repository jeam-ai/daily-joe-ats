"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  MapPin,
  CalendarDays,
  Pencil,
  UsersRound,
  BriefcaseBusiness,
  UserCheck,
  ListFilter,
  CircleHelp,
} from "lucide-react";
import type { HiringNeed } from "@/types";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Modal,
  ProgressBar,
  StatusBadge,
  LoadingSkeleton,
  EmptyState,
  MetricCard,
} from "./ui";
import Link from "next/link";
import { QualificationEditor } from "./qualification-editor";
import type { QualificationRule } from "@/types";
import { canManage } from "@/lib/data-policy";
import { RichTextEditor } from "./rich-text";

function operationalUrgency(need: HiringNeed) {
  if (need.status !== "Open") return need.urgency;
  const daysToTarget = Math.ceil(
    (Date.parse(need.targetDate) - Date.now()) / 86400000,
  );
  if (!Number.isFinite(daysToTarget)) return need.urgency;
  if (daysToTarget <= 0) return "Urgent";
  if (daysToTarget <= 7 && need.urgency !== "Urgent") return "High";
  return need.urgency;
}
export function HiringNeeds() {
  const { state, update, notify, saving, dataset } = useApp();
  const params = useSearchParams();
  const [editing, setEditing] = useState<string | null>(
    params.get("new") ? "new" : params.get("edit"),
  );
  const [rules, setRules] = useState<QualificationRule[] | null>(null);
  const [filter, setFilter] = useState("Open");
  if (!state) return <LoadingSkeleton />;
  const existing = state.hiringNeeds.find((n) => n.id === editing);
  const rows = state.hiringNeeds.filter(
    (n) => filter === "All" || n.status === filter,
  );
  const openNeeds = state.hiringNeeds.filter((n) => n.status === "Open");
  const vacancies = openNeeds.reduce(
    (total, need) => total + Math.max(0, need.slots - need.filled),
    0,
  );
  const hires = state.hiringNeeds.reduce(
    (total, need) => total + need.filled,
    0,
  );
  const requested = state.hiringNeeds
    .filter((n) => n.status !== "Closed")
    .reduce((total, need) => total + need.slots, 0);
  const pipeline = openNeeds.reduce(
    (total, need) =>
      total +
      (state.applicationSummary?.[dataset].activeByHiringNeed[need.id] || 0),
    0,
  );
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const need: HiringNeed = {
      id: existing?.id || crypto.randomUUID(),
      isDemo: existing?.isDemo,
      openedAt: String(data.get("openedAt") || "")
        ? new Date(
            `${String(data.get("openedAt"))}T00:00:00.000Z`,
          ).toISOString()
        : existing?.openedAt || new Date().toISOString(),
      position: String(data.get("position")),
      location: String(data.get("location")),
      slots: Number(data.get("slots")),
      filled: existing?.filled || 0,
      urgency: data.get("urgency") as HiringNeed["urgency"],
      targetDate: String(data.get("date")),
      status: data.get("status") as HiringNeed["status"],
      qualifications: "",
      criteria: rules || existing?.criteria || [],
      questions: String(data.get("questions")),
    };
    if (need.slots < need.filled) {
      notify("Requested slots cannot be fewer than filled slots.");
      return;
    }
    const saved = await update((s) => ({
      ...s,
      hiringNeeds: existing
        ? s.hiringNeeds.map((n) => (n.id === need.id ? need : n))
        : [...s.hiringNeeds, need],
    }));
    if (saved) {
      setEditing(null);
      setRules(null);
      notify("Hiring need saved and the staffing plan was refreshed.", "success");
    }
  }
  return (
    <div className="workspace-page hiring-needs-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">MAKE ROOM FOR GREAT PEOPLE</div>
          <h1>Hiring Needs</h1>
          <p>The right people. The right place. The right time.</p>
        </div>
        <div className="workspace-heading-side">
          <span className="workspace-heading-context">
            Staffing plan &amp; role requirements
          </span>
          <div className="button-row">
            <Button
              disabled={
                !canManage(state.currentUser) || saving || dataset === "demo"
              }
              title={
                dataset === "demo"
                  ? "Use the generated demo hiring needs, or exit demo to create a real request."
                  : undefined
              }
              onClick={() => {
                setRules([]);
                setEditing("new");
              }}
            >
              <Plus size={17} />
              New Hiring Need
            </Button>
          </div>
        </div>
      </div>
      <p className="workspace-heading-note">
        Define each opening once, then use the same requirements to guide
        applicant screening and HR decisions.
      </p>
      <div
        className="metrics-grid vacancy-metrics hiring-needs-summary"
        aria-label="Vacancy report"
      >
        <MetricCard
          label="Open vacancies"
          value={vacancies}
          note="Remaining across open hiring needs"
          icon={<BriefcaseBusiness size={20} />}
          href="/hiring-needs"
          tone="featured"
        />
        <MetricCard
          label="Hiring requests"
          value={openNeeds.length}
          note={`${requested} approved slots in active requests`}
          icon={<ListFilter size={20} />}
          href="/hiring-needs"
          tone="metric-review"
        />
        <MetricCard
          label="Hires recorded"
          value={hires}
          note="Filled slots across hiring needs"
          icon={<UserCheck size={20} />}
          href="/applications?status=Hired"
          tone="hired"
        />
        <MetricCard
          label="In pipeline"
          value={pipeline}
          note="Active applicants assigned to open needs"
          icon={<UsersRound size={20} />}
          href="/applications"
          tone="metric-interviews"
        />
      </div>
      <div className="section-heading workspace-section-toolbar">
        <h2>{rows.length} hiring requests</h2>
        <Select
          aria-label="Hiring need status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {["Open", "Paused", "Filled", "Closed", "All"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      </div>
      <div className="needs-grid">
        {rows.map((n) => (
          <Card key={n.id} className="need-card hiring-need-card">
            <div className="section-heading need-card-top">
              <span className="job-icon">
                <UsersRound size={24} />
              </span>
              <span title="Urgency is raised automatically when an open target is due within seven days or overdue.">
                <StatusBadge status={operationalUrgency(n)} />
              </span>
            </div>
            <h2>
              {n.isDemo ? "DEMO — " : ""}
              {n.position}
            </h2>
            <p className="location-line">
              <MapPin size={15} />
              {n.location}
            </p>
            {n.status === "Open" && (
              <p className="need-days-open">
                {n.openedAt
                  ? (() => {
                      const parsedOpenedAt = Date.parse(n.openedAt);
                      if (!Number.isFinite(parsedOpenedAt))
                        return "Open date not recorded";
                      const days = Math.max(
                        0,
                        Math.floor((Date.now() - parsedOpenedAt) / 86400000),
                      );
                      return days
                        ? `Open for ${days} day${days === 1 ? "" : "s"}`
                        : "Opened today";
                    })()
                  : "Open date not recorded"}
                <span
                  className="info-tooltip"
                  tabIndex={0}
                  aria-label="Days open explanation"
                >
                  <CircleHelp size={13} />
                  <span role="tooltip">
                    Days open is counted from the date HR declared this
                    vacancy open, not from a later edit.
                  </span>
                </span>
              </p>
            )}
            <div className="need-numbers">
              <div>
                <strong>{Math.max(0, n.slots - n.filled)}</strong>
                <span>open slots</span>
              </div>
              <div>
                <strong>
                  {state.applicationSummary?.[dataset].activeByHiringNeed[
                    n.id
                  ] || 0}
                </strong>
                <span>in pipeline</span>
              </div>
              <div>
                <strong>{n.filled}</strong>
                <span>filled</span>
              </div>
            </div>
            <div className="section-heading muted">
              <span>Hiring progress</span>
              <span>
                {n.filled} of {n.slots}
              </span>
            </div>
            <ProgressBar value={(n.filled / n.slots) * 100} />
            <p className="location-line">
              <CalendarDays size={15} />
              Target: {formatDate(n.targetDate, state.preferences)}
            </p>
            {(() => {
              const days = Math.ceil(
                (Date.parse(n.targetDate) - Date.now()) / 86400000,
              );
              if (!Number.isFinite(days)) return null;
              if (days > 7) return null;
              const graceDays = n.retentionExpiresAt
                ? Math.max(
                    0,
                    Math.ceil(
                      (Date.parse(n.retentionExpiresAt) - Date.now()) /
                        86400000,
                    ),
                  )
                : Math.max(0, days + 10);
              return (
                <p className="retention-inline">
                  {days > 0
                    ? `Hiring request target date is in ${days} day${days === 1 ? "" : "s"}.`
                    : graceDays > 0
                      ? `This hiring need becomes eligible for permanent cleanup in ${graceDays} day${graceDays === 1 ? "" : "s"} unless its target date is extended.`
                      : "Hiring need retention period has elapsed. Extend the target date to retain it."}
                </p>
              );
            })()}
            {(n.criteria?.length || 0) > 0 && (
              <details className="need-criteria">
                <summary>
                  {n.criteria!.length} qualification
                  {n.criteria!.length === 1 ? "" : "s"} configured
                </summary>
                <ul>
                  {n.criteria?.map((r) => (
                    <li key={r.id}>
                      {r.label} · {r.kind}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="need-card-footer">
              <Link className="text-link" href={`/applications?need=${n.id}`}>
                View associated applicants →
              </Link>
              <Badge>{n.status}</Badge>
              {n.id.startsWith("sample-need-") && (
                <Badge tone="amber">Sample configuration</Badge>
              )}
              <Button
                variant="secondary"
                disabled={!canManage(state.currentUser) || saving}
                onClick={() => {
                  setRules(n.criteria || []);
                  setEditing(n.id);
                }}
              >
                <Pencil size={14} />
                Edit request
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {!rows.length && (
        <EmptyState
          title={
            filter === "All"
              ? "No hiring needs yet"
              : `No ${filter.toLowerCase()} hiring needs`
          }
          description={
            state.hiringNeeds.length
              ? "Choose All to review existing requests and paused sample configurations."
              : "Create a request when your team is ready to grow."
          }
        />
      )}
      {editing && (
        <Modal
          busy={saving}
          title={existing ? "Edit hiring need" : "New hiring need"}
          onClose={() => setEditing(null)}
        >
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid">
              <Field label="Position">
                <Input
                  name="position"
                  required
                  defaultValue={existing?.position}
                  list="positions"
                />
                <datalist id="positions">
                  {state.qualifications.map((q) => (
                    <option key={q.id}>{q.position}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Location">
                <Select
                  name="location"
                  required
                  defaultValue={existing?.location || ""}
                >
                  <option value="">Select a location</option>
                  {state.locations
                    ?.filter((l) => l.active || l.name === existing?.location)
                    .map((l) => (
                      <option key={l.id}>{l.name}</option>
                    ))}
                </Select>
              </Field>
              <Field label="Slots">
                <Input
                  name="slots"
                  type="number"
                  min={Math.max(1, existing?.filled || 0)}
                  required
                  defaultValue={existing?.slots || 1}
                />
              </Field>
              <Field label="Urgency">
                <Select
                  name="urgency"
                  defaultValue={existing?.urgency || "Medium"}
                >
                  {["Urgent", "High", "Medium", "Low"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Target hiring date">
                <Input
                  type="date"
                  name="date"
                  required
                  defaultValue={existing?.targetDate}
                />
              </Field>
              <Field label="Opened on">
                <Input
                  type="date"
                  name="openedAt"
                  defaultValue={existing?.openedAt?.slice(0, 10) || ""}
                />
                <span
                  className="info-tooltip field-info"
                  tabIndex={0}
                  aria-label="Opened on explanation"
                >
                  <CircleHelp size={15} />
                  <span role="tooltip">
                    This is the date the vacancy was declared open. It drives
                    the Days open badge and is not the date HR last edited the
                    request.
                  </span>
                </span>
              </Field>
              <Field label="Status">
                <Select name="status" defaultValue={existing?.status || "Open"}>
                  {["Open", "Paused", "Filled", "Closed"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Start with a qualification template">
              <Select
                onChange={(e) =>
                  setRules(
                    state.qualifications.find((q) => q.id === e.target.value)
                      ?.rules || [],
                  )
                }
                defaultValue=""
              >
                <option value="">Choose template (optional)</option>
                {state.qualifications.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.position}
                  </option>
                ))}
              </Select>
            </Field>
            <QualificationEditor
              value={rules || existing?.criteria || []}
              onChange={setRules}
            />
            <Field label="Interview reference questions">
              <RichTextEditor
                name="questions"
                defaultValue={existing?.questions}
                rows={4}
                placeholder="Add interview reference questions"
              />
            </Field>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || !canManage(state.currentUser)}
              >
                {saving ? "Saving…" : "Save hiring need"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
