"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  CalendarDays,
  Check,
  HelpCircle,
  X,
  ArrowRight,
  Plus,
  FileCheck2,
} from "lucide-react";
import type {
  Application,
  ScreeningCriterion as Criterion,
  Interview,
} from "@/types";
import {
  nextStage,
  transition,
  renderTemplate,
  type Decision,
  isActive,
} from "@/lib/recruitment";
import { useApp } from "./provider";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  StatusBadge,
  Tabs,
  Modal,
  EmptyState,
  LoadingSkeleton,
} from "./ui";
import { ResumeViewer } from "./resume-viewer";
import { formatDate, scheduledIso } from "@/lib/dates";
import { Communication } from "./communication";
import { ApplicantTools } from "./applicant-tools";
export function ScreeningCriterion({ criterion: c }: { criterion: Criterion }) {
  return (
    <div className="criterion">
      <div>
        <span
          className={`criterion-icon ${c.result === "Met" ? "green" : c.result === "Unclear" ? "orange" : "red"}`}
        >
          {c.result === "Met" ? (
            <Check size={17} />
          ) : c.result === "Unclear" ? (
            <HelpCircle size={17} />
          ) : (
            <X size={17} />
          )}
        </span>
        <strong>{c.requirement}</strong>
        <StatusBadge status={c.result} />
      </div>
      <p>
        <b>Evidence:</b> {c.evidence}
      </p>
    </div>
  );
}
export function Timeline({ application }: { application: Application }) {
  return (
    <ol className="timeline">
      {[...application.timeline].reverse().map((event) => (
        <li key={event.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{event.action}</strong>
            <p>
              {event.user} · {new Date(event.timestamp).toLocaleString()}
            </p>
            {event.metadata.note && <p>{event.metadata.note}</p>}
            {event.metadata.communication && (
              <small>{event.metadata.communication}</small>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function ApplicantProfile({ id }: { id: string }) {
  const { state, updateApplication, notify } = useApp();
  const [tab, setTab] = useState("Overview");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!state) return <LoadingSkeleton />;
  const a = state.applications.find((a) => a.id === id);
  if (!a)
    return (
      <EmptyState
        title="Applicant not found"
        description="Return to Applications to select a record."
      />
    );
  const app = a;
  const actorEmail = state.currentUser?.email;
  const next = nextStage(a);
  const template =
    state.emailTemplates.find((t) => t.id === templateId) ||
    state.emailTemplates.find((t) => t.name === next) ||
    state.emailTemplates[0];
  const values = {
    company_name: "Daily Joe",
    applicant_name: a.applicant.name,
    position: a.position,
    location: a.location,
    interview_date: scheduled
      ? new Date(scheduled).toLocaleDateString()
      : "[date]",
    interview_time: scheduled
      ? new Date(scheduled).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "[time]",
  };
  async function change(action: string, fn: (a: Application) => Application) {
    if (
      !/note/i.test(action) &&
      !window.confirm(`${action} for ${app.applicant.name}?`)
    )
      return;
    await updateApplication(
      id,
      (a) => ({
        ...fn(a),
        lastActivity: new Date().toISOString(),
        timeline: [
          ...a.timeline,
          {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            user: state?.currentUser?.email || "HR",
            action,
            applicationId: id,
            metadata: { communication: "No email sent" },
          },
        ],
      }),
      true,
    );
  }
  function RequirementList({ compact = false }: { compact?: boolean }) {
    return (
      <div className={`requirement-checklist ${compact ? "compact" : ""}`}>
        {app.requirements.map((requirement) => {
          const checked = requirement.status === "Complete";
          return (
            <div className="requirement-check" key={requirement.id}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    void change("Requirement verified", (current) => ({
                      ...current,
                      requirements: current.requirements.map((item) =>
                        item.id === requirement.id
                          ? {
                              ...item,
                              status: e.target.checked ? "Complete" : "Pending",
                              verifiedBy: e.target.checked
                                ? actorEmail
                                : undefined,
                              date: e.target.checked
                                ? new Date().toISOString()
                                : undefined,
                            }
                          : item,
                      ),
                    }))
                  }
                />
                <span>{requirement.name}</span>
              </label>
              <StatusBadge status={requirement.status} />
              {requirement.notes && <small>{requirement.notes}</small>}
              {!compact && (
                <Input
                  aria-label={`${requirement.name} verification notes`}
                  placeholder="Verification notes (optional)"
                  defaultValue={requirement.notes}
                  onBlur={(e) => {
                    if (e.target.value !== requirement.notes)
                      void change("Requirement notes updated", (current) => ({
                        ...current,
                        requirements: current.requirements.map((item) =>
                          item.id === requirement.id
                            ? { ...item, notes: e.target.value }
                            : item,
                        ),
                      }));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }
  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!decision) return;
    const selectedDate = String(
      new FormData(e.currentTarget).get("scheduledAt") || scheduled,
    );
    setSaving(true);
    try {
      const result = transition(app, decision, {
        confirmed: true,
        scheduledAt: selectedDate
          ? scheduledIso(selectedDate, state?.preferences.timezone)
          : undefined,
        note: decisionNote,
        actor: state?.currentUser?.email,
      });
      const interviewer = String(
        new FormData(e.currentTarget).get("interviewer") || "",
      ).trim();
      if (interviewer && result.interviews.length)
        result.interviews[result.interviews.length - 1].notes =
          `Interviewer: ${interviewer}`;
      if (decision === "Reject") result.rejectionReason = reason;
      if (decision === "Withdraw") result.withdrawalReason = reason;
      if (!(await updateApplication(id, () => result, true))) return;
      setDecision(null);
      setDecisionNote("");
      notify("HR decision saved. No email was sent.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save decision.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Link className="back-link" href="/applications">
        <ArrowLeft size={16} />
        Back to applications
      </Link>
      <div className="profile-header">
        <Avatar name={a.applicant.name} />
        <div>
          <div className="profile-name">
            <h1>{a.applicant.name}</h1>
            <StatusBadge status={a.status} />
          </div>
          <p>
            {a.position} <span>·</span> {a.location}
          </p>
          <div className="profile-contact">
            <span>
              <Mail size={14} />
              {a.applicant.email}
            </span>
            <span>
              <Phone size={14} />
              {a.applicant.phone}
            </span>
            <span>
              <CalendarDays size={14} />
              Applied {formatDate(a.appliedAt, state.preferences)}
            </span>
          </div>
        </div>
      </div>
      <div className="stage-track">
        {[
          "Screening",
          "Initial Interview",
          "Final Interview",
          "Requirements",
          "Onboarding",
          "Hired",
        ].map((s, i) => (
          <div className={s === a.stage ? "current" : ""} key={s}>
            <span>{i + 1}</span>
            {s}
            {i < 5 && <ArrowRight size={14} />}
          </div>
        ))}
      </div>
      <Tabs
        items={[
          "Overview",
          "Interviews",
          "Requirements",
          "Onboarding",
          "Notes & timeline",
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="profile-columns">
        <div>
          {tab === "Overview" && (
            <>
              <Card>
                <div className="card-heading">
                  <div>
                    <h2>Resume</h2>
                    <p>The person behind the application.</p>
                  </div>
                  <Badge>Imported document</Badge>
                </div>
                <ResumeViewer application={a} />
              </Card>
              <Card className="spaced">
                <div className="card-heading">
                  <div>
                    <h2>Screening analysis</h2>
                    <p>HR evidence review against configured requirements.</p>
                  </div>
                  <StatusBadge status={a.screening.outcome} />
                </div>
                {a.screening.criteria.map((c) => (
                  <ScreeningCriterion key={c.id} criterion={c} />
                ))}
                {a.screening.insight && (
                  <div className="insight-banner">
                    <strong>System insight</strong>
                    <p>{a.screening.insight}</p>
                  </div>
                )}
                <div className="info-banner">
                  Screening is advisory. Missing evidence requires HR review;
                  the final decision belongs to HR.
                </div>
              </Card>
            </>
          )}
          {tab === "Interviews" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Interview information</h2>
                  <p>Record the conversation and its outcome.</p>
                </div>
              </div>
              {a.interviews.length ? (
                a.interviews.map((interview) => (
                  <div className="interview-detail" key={interview.id}>
                    <div className="section-heading">
                      <h3>{interview.stage}</h3>
                      <StatusBadge status={interview.status} />
                    </div>
                    <p>
                      <CalendarDays size={16} />{" "}
                      {formatDate(
                        interview.scheduledAt,
                        state.preferences,
                        true,
                      )}
                    </p>
                    <Field label="Interview result">
                      <Select
                        value={interview.status}
                        onChange={(e) =>
                          change("Interview result updated", (a) => ({
                            ...a,
                            interviews: a.interviews.map((i) =>
                              i.id === interview.id
                                ? {
                                    ...i,
                                    status: e.target
                                      .value as Interview["status"],
                                  }
                                : i,
                            ),
                          }))
                        }
                      >
                        {[
                          "Scheduled",
                          "Confirmed",
                          "Attended",
                          "No-show",
                          "Passed",
                          "Failed",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Interview notes">
                      <textarea
                        defaultValue={interview.notes}
                        key={interview.id}
                        onBlur={(e) => {
                          if (e.target.value !== interview.notes)
                            change("Interview notes updated", (a) => ({
                              ...a,
                              interviews: a.interviews.map((i) =>
                                i.id === interview.id
                                  ? { ...i, notes: e.target.value }
                                  : i,
                              ),
                            }));
                        }}
                      />
                    </Field>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="No interviews scheduled"
                  description="Use Proceed to schedule the next interview."
                />
              )}
            </Card>
          )}
          {tab === "Requirements" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Pre-employment requirements</h2>
                  <p>
                    HR verifies every document.{" "}
                    {
                      a.requirements.filter((r) => r.status === "Complete")
                        .length
                    }{" "}
                    of {a.requirements.length} complete.
                  </p>
                </div>
                <FileCheck2 size={22} />
              </div>
              <RequirementList />
            </Card>
          )}
          {tab === "Onboarding" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Onboarding</h2>
                  <p>
                    {a.applicant.name} · {a.position} · {a.location}
                  </p>
                </div>
              </div>
              <form
                className="padded form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const status = data.get(
                    "status",
                  ) as Application["onboardingStatus"];
                  if (
                    status === "Completed" &&
                    a.requirements.some((r) => r.status !== "Complete")
                  ) {
                    notify(
                      "Verify all requirements before completing onboarding.",
                    );
                    return;
                  }
                  if (
                    status !== "Pending Orientation" &&
                    (!data.get("orientation") || !data.get("commitment"))
                  ) {
                    notify("Set orientation and commitment dates first.");
                    return;
                  }
                  change("Onboarding updated", (a) => ({
                    ...a,
                    orientationDate: String(data.get("orientation")),
                    commitmentDate: String(data.get("commitment")),
                    onboardingStatus: status,
                    notes: data.get("notes")
                      ? [...a.notes, String(data.get("notes"))]
                      : a.notes,
                  }));
                }}
              >
                <div className="form-grid">
                  <Field label="Orientation date">
                    <Input
                      type="date"
                      name="orientation"
                      defaultValue={a.orientationDate}
                    />
                  </Field>
                  <Field label="Commitment date">
                    <Input
                      type="date"
                      name="commitment"
                      defaultValue={a.commitmentDate}
                    />
                  </Field>
                </div>
                <Field label="Onboarding status">
                  <Select name="status" defaultValue={a.onboardingStatus}>
                    {["Pending Orientation", "Scheduled", "Completed"].map(
                      (s) => (
                        <option key={s}>{s}</option>
                      ),
                    )}
                  </Select>
                </Field>
                <p>
                  Requirements:{" "}
                  {a.requirements.filter((r) => r.status === "Complete").length}
                  /{a.requirements.length} complete
                </p>
                <div className="section-heading compact-heading">
                  <h3>Requirements checklist</h3>
                  <StatusBadge
                    status={`${a.requirements.filter((r) => r.status === "Complete").length}/${a.requirements.length} complete`}
                  />
                </div>
                <RequirementList compact />
                <Field label="HR notes">
                  <textarea name="notes" />
                </Field>
                <Button type="submit">Save onboarding</Button>
              </form>
            </Card>
          )}
          {tab === "Notes & timeline" && (
            <Card>
              <div className="card-heading">
                <h2>Application timeline</h2>
              </div>
              <Timeline application={a} />
            </Card>
          )}
        </div>
        <aside>
          <ApplicantTools application={a} />
          <Communication application={a} />
          <Card className="decision-card">
            <div className="card-heading">
              <div>
                <h2>HR decision</h2>
                <p>Your judgment makes the difference.</p>
              </div>
            </div>
            <div className="padded">
              <div className="key-value">
                <span>Current stage</span>
                <strong>{a.stage}</strong>
              </div>
              <div className="key-value">
                <span>Screening</span>
                <StatusBadge status={a.screening.outcome} />
              </div>
              <div className="decision-actions">
                <Button
                  disabled={!isActive(a)}
                  onClick={() => {
                    setError("");
                    setDecision("Proceed");
                  }}
                >
                  Proceed <ArrowRight size={16} />
                </Button>
                <Button
                  variant="secondary"
                  disabled={!isActive(a)}
                  onClick={() => {
                    setError("");
                    setDecision("Review");
                  }}
                >
                  Review
                </Button>
                <Button
                  variant="danger"
                  disabled={!isActive(a)}
                  onClick={() => {
                    setError("");
                    setDecision("Reject");
                  }}
                >
                  Reject
                </Button>
              </div>
              <div className="minor-actions">
                <button
                  disabled={!isActive(a)}
                  onClick={() => {
                    setError("");
                    setDecision("Talent Pool");
                  }}
                >
                  Add to talent pool
                </button>
                <button
                  disabled={!isActive(a)}
                  onClick={() => {
                    setError("");
                    setDecision("Withdraw");
                  }}
                >
                  Mark withdrawn
                </button>
              </div>
              <p className="fine-print">
                Decisions require confirmation. Applicant communication is
                preview-only in this phase.
              </p>
            </div>
          </Card>
          <Card className="spaced">
            <div className="card-heading">
              <h2>HR notes</h2>
            </div>
            <form
              className="padded"
              onSubmit={(e) => {
                e.preventDefault();
                if (!note.trim()) return;
                change("HR note added", (a) => ({
                  ...a,
                  notes: [...a.notes, note.trim()],
                }));
                setNote("");
              }}
            >
              <textarea
                aria-label="HR Notes"
                placeholder="Add context for your team…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button variant="secondary" type="submit" disabled={!note.trim()}>
                <Plus size={15} />
                Add note
              </Button>
            </form>
            {a.notes.map((n, i) => (
              <p className="saved-note" key={i}>
                {n}
              </p>
            ))}
          </Card>
          {tab !== "Notes & timeline" && (
            <Card className="spaced">
              <div className="card-heading">
                <h2>Recent activity</h2>
              </div>
              <Timeline
                application={{ ...a, timeline: a.timeline.slice(-3) }}
              />
            </Card>
          )}
        </aside>
      </div>
      {decision && (
        <Modal
          title={
            decision === "Proceed"
              ? next === "Hired"
                ? "Mark Applicant as Hired"
                : "Proceed with applicant?"
              : decision === "Reject"
                ? "Reject Applicant"
                : decision === "Review"
                  ? "Flag for HR review?"
                  : decision === "Withdraw"
                    ? "Mark application as withdrawn?"
                    : "Add to talent pool?"
          }
          onClose={() => setDecision(null)}
        >
          <form onSubmit={confirm} className="form-stack">
            <div className="confirmation-summary">
              <Avatar name={a.applicant.name} />
              <div>
                <strong>{a.applicant.name}</strong>
                <p>
                  {a.position} · {a.location}
                </p>
              </div>
            </div>
            <div className="stage-change">
              <span>{a.stage}</span>
              <ArrowRight size={18} />
              <strong>{decision === "Proceed" ? next : decision}</strong>
            </div>
            {decision === "Proceed" && next.includes("Interview") && (
              <>
                <Field
                  label={`Interview date and time (${state.preferences.timezone || "Asia/Manila"})`}
                >
                  <Input
                    type="datetime-local"
                    name="scheduledAt"
                    required
                    value={scheduled}
                    onInput={(e) => setScheduled(e.currentTarget.value)}
                    min={new Date(
                      Date.now() +
                        60000 -
                        new Date().getTimezoneOffset() * 60000,
                    )
                      .toISOString()
                      .slice(0, 16)}
                    onChange={(e) => setScheduled(e.target.value)}
                  />
                </Field>
                <Field label="Interviewer">
                  <Input name="interviewer" placeholder="HR interviewer name" />
                </Field>
                <Field label="Email template">
                  <Select
                    value={template.id}
                    onChange={(e) => setTemplateId(e.target.value)}
                  >
                    {state.emailTemplates.map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="email-preview">
                  <div className="section-heading">
                    <h3>Communication</h3>
                    <Badge>Preview · send separately</Badge>
                  </div>
                  <p>
                    <b>Recipient:</b> {a.applicant.email}
                  </p>
                  <p>
                    <b>Subject:</b> {renderTemplate(template.subject, values)}
                  </p>
                  <pre>{renderTemplate(template.body, values)}</pre>
                </div>
              </>
            )}
            {(decision === "Reject" || decision === "Withdraw") && (
              <Field label="Reason (optional)">
                <Select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  <option value="">No reason provided</option>
                  {(decision === "Reject"
                    ? [
                        "Does not meet minimum qualifications",
                        "Failed initial interview",
                        "Failed final interview",
                        "Position filled",
                        "Other",
                      ]
                    : [
                        "Accepted another offer",
                        "Personal reasons",
                        "Schedule conflict",
                        "Location/commute",
                        "Compensation",
                        "Other",
                      ]
                  ).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Decision notes">
              <textarea
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Add your reason or next steps"
              />
            </Field>
            <p className="fine-print">
              This saves the application and audit history. No applicant email
              will be sent.
            </p>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDecision(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={saving}
                variant={decision === "Reject" ? "danger" : "primary"}
                type="submit"
              >
                {saving
                  ? "Saving…"
                  : decision === "Proceed"
                    ? "Confirm & Proceed"
                    : "Confirm decision"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
