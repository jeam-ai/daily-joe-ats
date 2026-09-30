"use client";
import { ApplicantInformation } from "./applicant-information";
import { applicantDisplayName } from "@/lib/applicant-information";
import Link from "next/link";
import { requestJson } from "@/lib/client-request";
import {
  emailContext,
  renderEmail,
  workflowTemplate,
} from "@/lib/email-templates";
import { EmailHistory, ViewEmail } from "./email-history";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { canManage, canEdit } from "@/lib/data-policy";
import { ApplicantEditor, DeleteApplicantDialog } from "./applicant-management";
import { RichTextContent, RichTextEditor } from "./rich-text";
import { ActionMenu } from "./action-menu";
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  CalendarDays,
  Clock3,
  Check,
  HelpCircle,
  X,
  ArrowRight,
  Plus,
  FileCheck2,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  Application,
  ApplicationTimelineEvent,
  ScreeningCriterion as Criterion,
  Interview,
} from "@/types";
import type { EmailRecord } from "@/types/email";
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
  RecruitmentStageGuide,
  LoadingSkeleton,
} from "./ui";
import { ResumeViewer } from "./resume-viewer";
import { formatDate, formatTime, scheduledIso } from "@/lib/dates";
import { Communication } from "./communication";
import { DocumentRecovery } from "./document-recovery";
import { ApplicationSource } from "./application-source";
import { AiAssist } from "./ai-assist";
import { AuditHistory } from "./operations";
import { ApplicantTools } from "./applicant-tools";
export function ScreeningCriterion({ criterion: c }: { criterion: Criterion }) {
  return (
    <div className="criterion">
      <div>
        <span
          className={`criterion-icon ${c.result === "Met" ? "green" : c.result === "Unclear" || c.result === "Not Assessed" ? "orange" : "red"}`}
        >
          {c.result === "Met" ? (
            <Check size={17} />
          ) : c.result === "Unclear" || c.result === "Not Assessed" ? (
            <HelpCircle size={17} />
          ) : (
            <X size={17} />
          )}
        </span>
        <strong>{c.requirement}</strong>
        <StatusBadge status={c.result} />
      </div>
      <div className="criterion-evidence">
        <b>Evidence:</b>
        <RichTextContent value={c.evidence} />
      </div>
    </div>
  );
}
export function Timeline({
  application,
  limit,
}: {
  application: Application;
  limit?: number;
}) {
  const { state } = useApp();
  const [gmailEvents, setGmailEvents] = useState<
    import("@/lib/gmail-activity").GmailThreadActivity[]
  >([]);
  useEffect(() => {
    if (!application.gmailThreadId || application.isDemo) return;
    const abort = new AbortController();
    const load = () =>
      requestJson<{
        events: import("@/lib/gmail-activity").GmailThreadActivity[];
      }>(
        `/api/gmail-activity?application=${encodeURIComponent(application.id)}`,
        { signal: abort.signal },
      )
        .then((result) => setGmailEvents(result.events))
        .catch(() => {});
    void load();
    const interval = setInterval(load, 60000);
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [application.id, application.gmailThreadId, application.isDemo]);
  const events: ApplicationTimelineEvent[] = [
    ...application.timeline,
    ...gmailEvents.map((event) => ({
      id: `gmail-${event.messageId}`,
      timestamp: event.occurredAt,
      user: "Careers Gmail",
      action:
        event.direction === "incoming"
          ? "Applicant replied"
          : "Email sent from Careers Gmail",
      metadata: { note: event.subject ? `Subject: ${event.subject}` : "" },
    })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <ol className="timeline">
      {events.slice(0, limit).map((event) => (
        <li key={event.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{event.action}</strong>
            <p>
              {event.user} ·{" "}
              {formatDate(event.timestamp, state?.preferences, true)}
            </p>
            {event.metadata.note && (
              <RichTextContent value={event.metadata.note} />
            )}
            {event.metadata.emailId && (
              <ViewEmail
                applicationId={application.id}
                emailId={event.metadata.emailId}
              />
            )}
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
  const {
    state,
    ensureApplication,
    updateApplication,
    refresh,
    notify,
    saving: workspaceSaving,
  } = useApp();
  const router = useRouter();
  const [editing, setEditing] = useState(false),
    [confirmEditing, setConfirmEditing] = useState(false),
    [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState("Overview");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingDelivery, setPendingDelivery] = useState<{
    emailId: string;
    stage: string;
  } | null>(null);
  const evidenceChecked = useRef(new Set<string>());
  const initialApplicationLoad = useRef<string | null>(null);
  const [pendingChange, setPendingChange] = useState<{
    action: string;
    value: Application;
  } | null>(null);
  useEffect(() => {
    if (!state || initialApplicationLoad.current === id) return;
    initialApplicationLoad.current = id;
    let current = true;
    setDetailLoading(true);
    // The workspace response is intentionally bounded, so a direct profile
    // route may initially render from a same-user cached detail. Always read
    // this one record once on mount to avoid showing a stale stage after a
    // confirmed Gmail transition.
    ensureApplication(id, true)
      .catch((cause) => {
        if (current) {
          initialApplicationLoad.current = null;
          setError((cause as Error).message);
        }
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [state, id, ensureApplication]);
  useEffect(() => {
    const application = state?.applications.find((item) => item.id === id);
    if (
      !application ||
      (!application.resumeId && application.source !== "Gmail") ||
      application.isDemo ||
      !canManage(state?.currentUser) ||
      evidenceChecked.current.has(id)
    )
      return;
    evidenceChecked.current.add(id);
    void requestJson<{ updated: number }>(`/api/applicants/${id}/processing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshStoredEvidence: true }),
    })
      .then((result) => {
        if (result.updated) return ensureApplication(id, true);
      })
      .catch(() => {
        // Normal profile loading remains available; the scheduled evidence
        // pass and Error Center handle an unavailable background refresh.
      });
  }, [
    id,
    state?.revision,
    state?.applications.length,
    state?.currentUser,
    ensureApplication,
  ]);
  useEffect(() => {
    if (!pendingDelivery) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDelivery = async () => {
      try {
        const result = await requestJson<{ emails: EmailRecord[] }>(
          `/api/applicants/${id}/emails`,
        );
        const mail = result.emails.find(
          (item) => item.id === pendingDelivery.emailId,
        );
        if (!mail || mail.status === "Queued" || mail.status === "Sending") {
          timer = setTimeout(() => void checkDelivery(), 2500);
          return;
        }
        if (cancelled) return;
        setPendingDelivery(null);
        await refresh({ background: true, force: true });
        // Profiles outside the bounded workspace list are held in the detail
        // cache. Fetch this record explicitly so a confirmed transition is
        // never hidden behind a prior cached Screening-stage snapshot.
        await ensureApplication(id, true);
        if (mail.status === "Sent") {
          notify(
            `Email sent. Applicant automatically moved to ${pendingDelivery.stage}.`,
          );
          return;
        }
        notify(
          mail.status === "Unconfirmed"
            ? "Gmail could not confirm delivery. Review the email before retrying."
            : "Gmail could not send the email. Review the delivery error before retrying.",
          "error",
        );
      } catch {
        if (!cancelled) timer = setTimeout(() => void checkDelivery(), 5000);
      }
    };
    void checkDelivery();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ensureApplication, id, notify, pendingDelivery, refresh]);
  if (!state) return <LoadingSkeleton />;
  const a = state.applications.find((a) => a.id === id);
  if (!a) if (detailLoading) return <LoadingSkeleton />;
  if (!a)
    return (
      <EmptyState
        title="Applicant not found"
        description="Return to Applications to select a record."
      />
    );
  const app = a;
  const editable = canEdit(state.currentUser, a);
  const manager = canManage(state.currentUser);
  const talentStarted = Date.parse(a.talentPoolAddedAt || a.appliedAt);
  const talentExpires = a.talentPoolExpiresAt
    ? Date.parse(a.talentPoolExpiresAt)
    : talentStarted + 30 * 86400000;
  const talentGraceExpires = a.talentPoolGraceExpiresAt
    ? Date.parse(a.talentPoolGraceExpiresAt)
    : talentStarted + 40 * 86400000;
  const talentPoolDays = Math.ceil((talentExpires - Date.now()) / 86400000);
  const talentGraceDays = Math.ceil(
    (talentGraceExpires - Date.now()) / 86400000,
  );
  const configuredTalentDays = Math.max(
    1,
    Math.round((talentExpires - talentStarted) / 86400000),
  );
  const actorEmail = state.currentUser?.email;
  const next = nextStage(a);
  const requestEdit = () => {
    if (editable) setConfirmEditing(true);
  };
  const template =
    state.emailTemplates.find(
      (t) => t.id === templateId && t.enabled !== false,
    ) || workflowTemplate(state, next);
  const previewApplication = {
    ...a,
    stage: next,
    interviews: scheduled
      ? [
          ...a.interviews,
          {
            id: "preview",
            stage: next as Interview["stage"],
            scheduledAt: scheduledIso(scheduled, state.preferences.timezone),
            status: "Scheduled" as const,
            notes: "",
          },
        ]
      : a.interviews,
  };
  const preview =
    template && state.currentUser
      ? renderEmail(
          template,
          emailContext(previewApplication, state, state.currentUser),
        )
      : null;
  async function change(action: string, fn: (a: Application) => Application) {
    if (!/note/i.test(action)) {
      setPendingChange({ action, value: fn(app) });
      return false;
    }
    return await updateApplication(
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
  function requirementList({ compact = false }: { compact?: boolean }) {
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
                  disabled={!editable || workspaceSaving}
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
                  disabled={!editable || workspaceSaving}
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
      if (decision === "Proceed") {
        const result = await requestJson<{
          message: string;
          emailId?: string;
          pendingStage?: string;
        }>(`/api/applicants/${id}/proceed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedStage: app.stage,
            confirmed: true,
            scheduledAt: selectedDate
              ? scheduledIso(selectedDate, state?.preferences.timezone)
              : undefined,
            note: decisionNote,
            interviewer: String(
              new FormData(e.currentTarget).get("interviewer") || "",
            ),
            templateId: template?.id,
          }),
        });
        await refresh({ background: true });
        setDecision(null);
        setDecisionNote("");
        if (result.emailId) {
          setPendingDelivery({
            emailId: result.emailId,
            stage: result.pendingStage || next,
          });
          notify(
            "Email delivery is in progress. This page will update automatically once Gmail confirms it was sent.",
            "info",
          );
        } else notify(result.message);
        return;
      }
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
        <div className="applicant-avatar-wrap">
          <Avatar
            name={applicantDisplayName(a)}
            imageUrl={
              a.applicantPhotoId
                ? `/api/applicants/${a.id}/photo?v=${encodeURIComponent(a.applicantPhotoVersion || "1")}`
                : undefined
            }
          />
          {editable && (
            <button
              className="avatar-edit"
              type="button"
              onClick={requestEdit}
              aria-label="Edit applicant information and optional photo"
              title="Edit applicant information and optional photo"
            >
              <Pencil size={14} />
            </button>
          )}
        </div>
        <div>
          <div className="profile-name">
            <h1>{applicantDisplayName(a)}</h1>
            <StatusBadge status={a.status} />
            {a.isDemo && <Badge tone="amber">DEMO DATA</Badge>}
            {manager && (
              <div
                className="profile-quick-actions"
                aria-label="Applicant actions"
              >
                <Button
                  variant="secondary"
                  disabled={!isActive(a) || workspaceSaving}
                  onClick={() => {
                    setError("");
                    setDecision("Reject");
                  }}
                >
                  <X size={14} /> Reject
                </Button>
                <Button
                  variant="secondary"
                  disabled={!isActive(a) || workspaceSaving}
                  onClick={() => {
                    setError("");
                    setDecision("Withdraw");
                  }}
                >
                  <ArrowRight size={14} /> Withdraw
                </Button>
                <Button
                  variant="secondary"
                  disabled={workspaceSaving}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
            )}
          </div>
          <p>
            {a.id} <span>·</span> {a.position} <span>·</span> {a.location}
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
      <ApplicationSource
        application={a}
        editable={editable}
        onEdit={requestEdit}
      />
      {a.retentionExpiresAt &&
        ["outside_live_queue", "terminal"].includes(
          a.retentionCategory || "",
        ) && (
          <Card className="spaced retention-card">
            <h2>
              <Clock3 size={17} /> Application retention
            </h2>
            <p>
              {a.retentionCategory === "outside_live_queue"
                ? "Outside the newest 500 live applications."
                : "Rejected, withdrawn, or no-response retention is pending."}{" "}
              Permanent cleanup becomes eligible in{" "}
              {Math.max(
                0,
                Math.ceil(
                  (Date.parse(a.retentionExpiresAt) - Date.now()) / 86400000,
                ),
              )}{" "}
              days. HR can correct the application while it remains available.
            </p>
          </Card>
        )}
      {a.status === "Talent Pool" && (
        <Card className="spaced retention-card">
          <div className="card-heading">
            <div>
              <h2>
                <Clock3 size={17} /> Talent Pool retention
              </h2>
              <p>
                {a.talentPoolExpiredAt
                  ? "This applicant has left the Talent Pool. Their application history remains available."
                  : talentPoolDays > 0
                    ? `Talent Pool expires in ${talentPoolDays} day${talentPoolDays === 1 ? "" : "s"}.`
                    : `Talent Pool grace ${talentGraceDays > 0 ? `ends in ${talentGraceDays} day${talentGraceDays === 1 ? "" : "s"}` : "has ended"}. Retain applicant to keep them in the pool.`}
              </p>
            </div>
            {!a.talentPoolExpiredAt && (
              <Badge tone={talentPoolDays <= 7 ? "orange" : "neutral"}>
                Expires{" "}
                {formatDate(
                  new Date(talentExpires).toISOString(),
                  state.preferences,
                )}
              </Badge>
            )}
          </div>
          {manager && (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await requestJson(
                    `/api/applicants/${encodeURIComponent(a.id)}/retention`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "retain-talent-pool" }),
                    },
                  );
                  await refresh();
                  notify(
                    `Talent Pool retention reset for ${configuredTalentDays} days.`,
                  );
                } catch (error) {
                  notify((error as Error).message, "error");
                } finally {
                  setSaving(false);
                }
              }}
            >
              Retain / Reset {configuredTalentDays} days
            </Button>
          )}
        </Card>
      )}
      <DocumentRecovery application={a} />
      <RecruitmentStageGuide currentStage={a.stage} />
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
              <ApplicantInformation
                application={a}
                editable={editable}
                onEdit={requestEdit}
              />
              <Card className="spaced">
                <div className="card-heading">
                  <div>
                    <h2>Resume</h2>
                    <p>The person behind the application.</p>
                  </div>
                  <Badge>
                    {a.isDemo
                      ? "Demo evidence"
                      : a.resumeId
                        ? "Resume attached"
                        : "No resume yet"}
                  </Badge>
                </div>
                <ResumeViewer application={a} />
              </Card>
              <Card className="spaced">
                <div className="card-heading">
                  <div>
                    <h2>Qualification dashboard</h2>
                    <p>HR evidence review against configured requirements.</p>
                  </div>
                  <StatusBadge status={a.screening.outcome} />
                </div>
                <div className="qualification-dashboard-summary">
                  {a.screening.criteria.length ? (
                    <>
                      <strong>
                        {
                          a.screening.criteria.filter(
                            (criterion) => criterion.result === "Met",
                          ).length
                        }
                        /{a.screening.criteria.length} supported by evidence
                      </strong>
                      <span>
                        {
                          a.screening.criteria.filter(
                            (criterion) =>
                              criterion.result === "Unclear" ||
                              criterion.result === "Not Assessed",
                          ).length
                        }{" "}
                        still need HR review
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Position qualifications not assigned</strong>
                      <span>
                        Choose a position set in System Analysis before
                        screening this resume.
                      </span>
                    </>
                  )}
                </div>
                <details className="qualification-evidence">
                  <summary>
                    View requirement evidence ({a.screening.criteria.length})
                  </summary>
                  {a.screening.criteria.map((c) => (
                    <ScreeningCriterion key={c.id} criterion={c} />
                  ))}
                </details>
                <p className="fine-print qualification-dashboard-note">
                  Screening is advisory. HR confirms evidence and makes the
                  final decision.
                </p>
              </Card>
            </>
          )}
          {tab === "Overview" && (
            <Card className="spaced profile-optional-tools">
              <details>
                <summary>Optional AI and communication tools</summary>
                <p className="fine-print">
                  Use only when a second interpretation or saved workflow
                  message is needed.
                </p>
                <AiAssist id={a.id} />
                <EmailHistory applicationId={a.id} />
              </details>
            </Card>
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
                        disabled={!editable || workspaceSaving}
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
                      <RichTextEditor
                        disabled={!editable || workspaceSaving}
                        defaultValue={interview.notes}
                        key={interview.id}
                        onBlur={(value) => {
                          if (value !== interview.notes)
                            change("Interview notes updated", (a) => ({
                              ...a,
                              interviews: a.interviews.map((i) =>
                                i.id === interview.id
                                  ? { ...i, notes: value }
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
              {requirementList({})}
            </Card>
          )}
          {tab === "Onboarding" && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Onboarding</h2>
                  <p>
                    {applicantDisplayName(a)} · {a.position} · {a.location}
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
                {requirementList({ compact: true })}
                <Field label="HR notes">
                  <RichTextEditor name="notes" rows={3} />
                </Field>
                <Button type="submit" disabled={!editable || workspaceSaving}>
                  Save onboarding
                </Button>
              </form>
            </Card>
          )}
          {tab === "Notes & timeline" && (
            <Card>
              <div className="card-heading">
                <h2>Application timeline</h2>
              </div>
              <Timeline application={a} />
              <AuditHistory applicant={a.id} />
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
                  disabled={!manager || !isActive(a) || workspaceSaving}
                  onClick={() => {
                    setError("");
                    setDecision("Proceed");
                  }}
                >
                  Proceed <ArrowRight size={16} />
                </Button>
                <ActionMenu
                  items={[
                    {
                      label: "Edit Applicant",
                      onClick: requestEdit,
                      disabled: !editable,
                    },
                    {
                      label: "Add Note",
                      onClick: () =>
                        document
                          .querySelector<HTMLElement>('[aria-label="HR Notes"]')
                          ?.focus(),
                      disabled: !editable,
                    },
                    ...(
                      [
                        "Review",
                        "Reject",
                        "Withdraw",
                        "Talent Pool",
                      ] as Decision[]
                    ).map((action) => ({
                      label:
                        action === "Talent Pool"
                          ? "Move to Talent Pool"
                          : action,
                      onClick: () => {
                        setError("");
                        setDecision(action);
                      },
                      disabled: !manager || !isActive(a),
                      danger: action === "Reject",
                    })),
                    {
                      label: "Delete Applicant",
                      onClick: () => setDeleting(true),
                      disabled: !manager,
                      danger: true,
                    },
                  ]}
                />
              </div>
              <p className="fine-print">
                Decisions require confirmation. Emails are previewed and sent
                separately.
              </p>
            </div>
          </Card>
          <Card className="spaced">
            <div className="card-heading">
              <h2>HR notes</h2>
            </div>
            <form
              className="padded"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!note.trim()) return;
                const saved = await change("HR note added", (a) => ({
                  ...a,
                  notes: [...a.notes, note.trim()],
                }));
                if (saved) setNote("");
              }}
            >
              <RichTextEditor
                aria-label="HR Notes"
                placeholder="Add context for your team…"
                value={note}
                onChange={setNote}
                rows={4}
              />
              <Button
                variant="secondary"
                type="submit"
                disabled={!note.trim() || !editable || workspaceSaving}
              >
                <Plus size={15} />
                Add note
              </Button>
            </form>
            {a.notes.map((n, i) => (
              <RichTextContent className="saved-note" key={i} value={n} />
            ))}
          </Card>
          {tab !== "Notes & timeline" && (
            <Card className="spaced">
              <div className="card-heading">
                <h2>Recent activity</h2>
              </div>
              <Timeline application={a} limit={3} />
            </Card>
          )}
        </aside>
      </div>
      {pendingChange && (
        <Modal
          busy={workspaceSaving}
          title="Confirm applicant update"
          onClose={() => setPendingChange(null)}
        >
          <p>
            <strong>{pendingChange.action}</strong> for{" "}
            {applicantDisplayName(a)}?
          </p>
          <p>This saves the update and audit history. No email will be sent.</p>
          <div className="modal-actions">
            <Button
              disabled={workspaceSaving}
              variant="secondary"
              onClick={() => setPendingChange(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={workspaceSaving}
              onClick={async () => {
                if (
                  await updateApplication(id, () => pendingChange.value, true)
                )
                  setPendingChange(null);
              }}
            >
              {workspaceSaving ? "Saving…" : "Confirm update"}
            </Button>
          </div>
        </Modal>
      )}
      {confirmEditing && (
        <Modal
          title="Edit applicant information?"
          onClose={() => setConfirmEditing(false)}
        >
          <p>
            Changes saved by HR become the authoritative applicant information
            and will not be silently replaced by a later Gmail sync, document
            extraction, or AI fallback.
          </p>
          <p>
            The original submitted evidence remains preserved in the activity
            and audit history. Adding an applicant photo is optional.
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => setConfirmEditing(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmEditing(false);
                setEditing(true);
              }}
            >
              Continue editing
            </Button>
          </div>
        </Modal>
      )}
      {editing && (
        <ApplicantEditor application={a} onClose={() => setEditing(false)} />
      )}
      {deleting && (
        <DeleteApplicantDialog
          application={a}
          onClose={() => setDeleting(false)}
          onDeleted={() => router.push("/applications")}
        />
      )}
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
          busy={saving || workspaceSaving}
          onClose={() => setDecision(null)}
        >
          <form onSubmit={confirm} className="form-stack">
            <div className="confirmation-summary">
              <Avatar name={applicantDisplayName(a)} />
              <div>
                <strong>{applicantDisplayName(a)}</strong>
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
              </>
            )}
            {decision === "Proceed" && !a.isDemo && (
              <div className="email-preview">
                <div className="section-heading">
                  <h3>Configured workflow email</h3>
                  <Badge>Queued on confirmation</Badge>
                </div>
                <p>
                  <b>Recipient:</b> {a.applicant.email}
                </p>
                <p>
                  <b>Template:</b> {template?.name || "Not configured"}
                </p>
                {preview && (
                  <>
                    <p>
                      <b>Subject:</b> {preview.subject}
                    </p>
                    <pre>{preview.body}</pre>
                  </>
                )}
                {(!preview || preview.missing.length > 0) && (
                  <div className="warning-banner">
                    Stage progression will wait until this email issue is
                    resolved:{" "}
                    {preview?.missing.join(", ") ||
                      "configure this stage's template in Settings"}
                    . No incomplete email will be sent.
                  </div>
                )}
              </div>
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
              <RichTextEditor
                value={decisionNote}
                onChange={setDecisionNote}
                placeholder="Add your reason or next steps"
                rows={3}
              />
            </Field>
            <p className="fine-print">
              {decision === "Proceed" && !a.isDemo
                ? "Confirming queues the email shown above. The stage advances only after Gmail confirms delivery. Failed or uncertain sends remain in Email history for review and retry."
                : "This saves the application and audit history. No applicant email will be sent."}
            </p>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <Button
                disabled={saving || workspaceSaving}
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
