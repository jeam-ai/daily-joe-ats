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
  HelpTip,
} from "./ui";
import Link from "next/link";
import { QualificationEditor } from "./qualification-editor";
import type { QualificationRule } from "@/types";
import { canManage } from "@/lib/data-policy";
import { RichTextEditor } from "./rich-text";
import { requestJson } from "@/lib/client-request";

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
  const { state, notify, patchState, dataset } = useApp();
  const params = useSearchParams();
  const [editing, setEditing] = useState<string | null>(
    params.get("new") ? "new" : params.get("edit"),
  );
  const [rules, setRules] = useState<QualificationRule[] | null>(null);
  const [filter, setFilter] = useState("Open");
  const [savingNeed, setSavingNeed] = useState(false);
  const [confirmOpeningDates, setConfirmOpeningDates] = useState(false);
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
  const needsOpeningDateStandardization = state.hiringNeeds.filter(
    (need) =>
      !need.isDemo && need.openedAt !== "2026-09-20T00:00:00.000Z",
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
    setSavingNeed(true);
    try {
      const result = await requestJson<{ hiringNeed: HiringNeed }>(
        "/api/hiring-needs",
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(need),
        },
      );
      patchState((current) => ({
        ...current,
        hiringNeeds: current.hiringNeeds.some(
          (item) => item.id === result.hiringNeed.id,
        )
          ? current.hiringNeeds.map((item) =>
              item.id === result.hiringNeed.id ? result.hiringNeed : item,
            )
          : [...current.hiringNeeds, result.hiringNeed],
      }));
      setEditing(null);
      setRules(null);
      notify("Hiring need saved and the staffing plan was refreshed.", "success");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setSavingNeed(false);
    }
  }
  async function standardizeOpeningDates() {
    setSavingNeed(true);
    try {
      const result = await requestJson<{
        updated: number;
        hiringNeeds: HiringNeed[];
      }>("/api/hiring-needs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openedAt: "2026-09-20", confirmed: true }),
      });
      const updated = new Map(result.hiringNeeds.map((need) => [need.id, need]));
      if (updated.size)
        patchState((current) => ({
          ...current,
          hiringNeeds: current.hiringNeeds.map(
            (need) => updated.get(need.id) || need,
          ),
        }));
      setConfirmOpeningDates(false);
      notify(
        result.updated
          ? `Set the opening date to Sep 20, 2026 for ${result.updated} hiring need${result.updated === 1 ? "" : "s"}.`
          : "All real hiring needs already use the Sep 20, 2026 opening date.",
        "success",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setSavingNeed(false);
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
                !canManage(state.currentUser) || savingNeed || dataset === "demo"
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
      {!!needsOpeningDateStandardization.length && dataset === "real" && (
        <Card className="opening-date-notice">
          <div>
            <h2>Confirm opening dates</h2>
            <p>
              {needsOpeningDateStandardization.length} real hiring request
              {needsOpeningDateStandardization.length === 1 ? " is" : "s are"} not
              yet recorded as opened on Sep 20, 2026.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={!canManage(state.currentUser) || savingNeed}
            onClick={() => setConfirmOpeningDates(true)}
          >
            Set Sep 20 opening date
          </Button>
        </Card>
      )}
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
                <HelpTip
                  label="Days open explanation"
                  icon={<CircleHelp size={13} aria-hidden />}
                >
                  Days open is counted from the date HR declared this vacancy
                  open, not from a later edit.
                </HelpTip>
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
                disabled={!canManage(state.currentUser) || savingNeed}
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
          busy={savingNeed}
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
                <HelpTip
                  className="field-info"
                  label="Opened on explanation"
                  icon={<CircleHelp size={15} aria-hidden />}
                >
                  This is the date the vacancy was declared open. It drives the
                  Days open badge and is not the date HR last edited the request.
                </HelpTip>
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
                disabled={savingNeed || !canManage(state.currentUser)}
              >
                {savingNeed ? "Saving…" : "Save hiring need"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {confirmOpeningDates && (
        <Modal
          busy={savingNeed}
          title="Confirm opening dates"
          onClose={() => setConfirmOpeningDates(false)}
        >
          <div className="form-stack">
            <p>
              Set the opened-on date to <strong>Sep 20, 2026</strong> for all
              real hiring needs. This changes only the days-open reference;
              roles, locations, vacancies, qualifications, and target dates
              stay unchanged.
            </p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                type="button"
                disabled={savingNeed}
                onClick={() => setConfirmOpeningDates(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={savingNeed}
                onClick={() => void standardizeOpeningDates()}
              >
                {savingNeed ? "Saving…" : "Confirm date update"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
