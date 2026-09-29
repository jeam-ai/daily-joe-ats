"use client";
import { useState } from "react";
import type { Application, ScreeningCriterion } from "@/types";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import { Sparkles } from "lucide-react";
import { canManage } from "@/lib/data-policy";
import { qualificationRulesForPosition } from "@/lib/screening";
import { ScreeningControls } from "./screening-controls";
import { RichTextContent, RichTextEditor } from "./rich-text";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Modal,
  StatusBadge,
} from "./ui";

function screeningOutcome(criteria: ScreeningCriterion[]) {
  if (
    !criteria.length ||
    criteria.some((criterion) =>
      ["Unclear", "Not Assessed"].includes(criterion.result),
    )
  )
    return "Requires Review" as const;
  return criteria.some((criterion) => criterion.result === "Not Met")
    ? ("Criteria Not Met" as const)
    : ("Meets Criteria" as const);
}

export function ApplicantTools({
  application: a,
}: {
  application: Application;
}) {
  const { state, updateApplication, saving } = useApp();
  const [employment, setEmployment] = useState(false),
    [review, setReview] = useState(false),
    [assignment, setAssignment] = useState(false),
    [assignmentNeedId, setAssignmentNeedId] = useState(a.hiringNeedId || ""),
    [checklistConfirmation, setChecklistConfirmation] = useState(false),
    [checklistDraft, setChecklistDraft] = useState<Record<string, boolean>>({});
  if (!state) return null;
  const need = state.hiringNeeds.find((n) => n.id === a.hiringNeedId);
  const qualificationNeeds = state.hiringNeeds.filter(
    (candidate) =>
      candidate.status === "Open" &&
      qualificationRulesForPosition(
        candidate.position,
        candidate.criteria,
        state.qualifications,
      ).length > 0,
  );
  const needsQualificationAssignment =
    !a.screening.criteria.length ||
    a.screening.criteria.some(
      (criterion) => criterion.result === "Not Assessed",
    );
  const directMatches = a.screening.criteria.filter(
    (criterion) => criterion.result === "Met",
  ).length;
  const needsReview = a.screening.criteria.filter((criterion) =>
    ["Unclear", "Not Assessed"].includes(criterion.result),
  ).length;
  const canReviewCriteria = canManage(state.currentUser) && !saving;
  const checklistChanged = a.screening.criteria.some(
    (criterion) =>
      criterion.id in checklistDraft &&
      checklistDraft[criterion.id] !== (criterion.result === "Met"),
  );
  const draftMetCount = a.screening.criteria.filter((criterion) =>
    criterion.id in checklistDraft
      ? checklistDraft[criterion.id]
      : criterion.result === "Met",
  ).length;
  async function saveChecklist() {
    const saved = await updateApplication(
      a.id,
      (application) => {
        const criteria = application.screening.criteria.map((criterion) => {
          if (!(criterion.id in checklistDraft)) return criterion;
          const met = checklistDraft[criterion.id];
          return {
            ...criterion,
            result: met ? ("Met" as const) : ("Not Assessed" as const),
            evidence: met
              ? criterion.evidence ||
                "HR marked this qualification as present after reviewing the submitted resume."
              : "Awaiting HR qualification review.",
          };
        });
        return {
          ...application,
          screening: {
            ...application.screening,
            method: "hr",
            criteria,
            completedAt: new Date().toISOString(),
            outcome: screeningOutcome(criteria),
          },
        };
      },
      true,
    );
    if (saved) {
      setChecklistDraft({});
      setChecklistConfirmation(false);
    }
  }
  return (
    <>
      {a.stage === "Initial Interview" && (
        <Card className="spaced">
          <div className="card-heading">
            <div>
              <h2>Interview owner</h2>
              <p>Optional interviewer for this stage.</p>
            </div>
            <StatusBadge status={need?.position || a.position} />
          </div>
          <div className="padded form-stack">
            <Field label="HR interviewer">
              <Select
                disabled={!canManage(state.currentUser) || saving}
                value={a.assignedTo || ""}
                onChange={async (e) => {
                  const value = e.target.value || undefined;
                  await updateApplication(
                    a.id,
                    (v) => ({ ...v, assignedTo: value }),
                    true,
                  );
                }}
              >
                <option value="">Choose later</option>
                {state.users
                  ?.filter((u) => u.active && u.role !== "Viewer")
                  .map((u) => (
                    <option key={u.id} value={u.email}>
                      {u.name || u.email}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        </Card>
      )}
      <Card className="spaced system-insight">
        <div className="card-heading">
          <h2>
            <Sparkles size={17} /> System Analysis · Insight
          </h2>
          <Badge tone="purple">
            {a.screening.method === "ai"
              ? "AI-assisted"
              : a.isDemo
                ? "Demo evidence"
                : a.screening.method === "hr"
                  ? "HR-reviewed"
                  : "Built-in engine"}
          </Badge>
        </div>
        <div className="padded">
          <p className="system-insight-summary">
            {a.screening.insight ||
              "Review the resume against the qualifications configured for this hiring need. Unstated information remains unclear."}
          </p>
          <div className="system-insight-metrics">
            <Badge tone={directMatches ? "green" : "orange"}>
              Match{" "}
              {a.screening.criteria.length
                ? Math.round(
                    (directMatches / a.screening.criteria.length) * 100,
                  ) + "%"
                : "Not assessed"}
            </Badge>
            <Badge tone={needsReview ? "orange" : "green"}>
              {needsReview}{" "}
              {needsReview === 1 ? "criterion needs" : "criteria need"} review
            </Badge>
          </div>
          <details className="evidence-details">
            <summary>Review system evidence and tools</summary>
            <p className="fine-print">
              {directMatches} of {a.screening.criteria.length} configured
              qualifications are met. OCR and text matching are advisory; HR
              makes every final decision.
            </p>
            <ul>
              {a.screening.criteria.map((c) => (
                <li key={c.id}>
                  <strong>{c.requirement}</strong>
                  <RichTextContent value={c.evidence} />
                </li>
              ))}
            </ul>
            <ScreeningControls application={a} />
            <Button
              variant="secondary"
              disabled={
                !canManage(state.currentUser) || !a.screening.criteria.length
              }
              onClick={() => setReview(true)}
            >
              Review criteria and evidence
            </Button>
          </details>
          {needsQualificationAssignment && qualificationNeeds.length > 0 && (
            <div className="inline-actions qualification-assignment-action">
              <p className="fine-print">
                {a.screening.criteria.length
                  ? "Assign a different position’s qualification set, then the saved resume is scanned again automatically."
                  : "No qualification set is assigned yet. Choose the position and location HR wants to assess."}
              </p>
              <Button
                variant="secondary"
                disabled={!canManage(state.currentUser) || saving}
                onClick={() => {
                  setAssignmentNeedId(
                    a.hiringNeedId || qualificationNeeds[0].id,
                  );
                  setAssignment(true);
                }}
              >
                Assign qualification set
              </Button>
            </div>
          )}
          {need?.questions && (
            <>
              <h3>Interview reference questions</h3>
              <pre className="reference-questions">{need.questions}</pre>
              <p>Record the applicant’s actual answers in interview notes.</p>
            </>
          )}
        </div>
      </Card>
      {a.screening.criteria.length > 0 && (
        <Card className="spaced hr-qualification-checklist">
          <div className="card-heading">
            <div>
              <h2>HR qualification checklist</h2>
              <p>Tick only what is supported by the submitted resume.</p>
            </div>
            <Badge tone="blue">
              {draftMetCount}/{a.screening.criteria.length} met
            </Badge>
          </div>
          <div className="qualification-checklist-body">
            {a.screening.criteria.map((criterion) => (
              <label className="qualification-check" key={criterion.id}>
                <input
                  type="checkbox"
                  checked={
                    criterion.id in checklistDraft
                      ? checklistDraft[criterion.id]
                      : criterion.result === "Met"
                  }
                  disabled={!canReviewCriteria}
                  onChange={(event) =>
                    setChecklistDraft((draft) => ({
                      ...draft,
                      [criterion.id]: event.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>{criterion.requirement}</strong>
                  <small>
                    {criterion.result === "Met"
                      ? "Marked met"
                      : criterion.result === "Not Assessed"
                        ? "Not assessed — tick if found"
                        : criterion.result}
                  </small>
                </span>
              </label>
            ))}
            {!canManage(state.currentUser) && (
              <p className="fine-print">
                A recruitment manager can update this checklist.
              </p>
            )}
            {canManage(state.currentUser) && (
              <Button
                variant="secondary"
                disabled={!checklistChanged || saving}
                onClick={() => setChecklistConfirmation(true)}
              >
                Save HR checklist
              </Button>
            )}
          </div>
        </Card>
      )}
      {checklistConfirmation && (
        <Modal
          busy={saving}
          title="Confirm qualification checklist"
          onClose={() => setChecklistConfirmation(false)}
        >
          <div className="form-stack">
            <p>
              {a.applicant.name} · {a.position}
            </p>
            <p>
              You are marking <strong>{draftMetCount}</strong> of{" "}
              {a.screening.criteria.length} configured qualifications as met.
            </p>
            <p className="fine-print">
              This records an HR review and updates the qualification total. It
              does not advance, reject, or email the applicant.
            </p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => setChecklistConfirmation(false)}
              >
                Cancel
              </Button>
              <Button disabled={saving} onClick={() => void saveChecklist()}>
                {saving ? "Saving…" : "Confirm & save"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {assignment && (
        <Modal
          busy={saving}
          title="Assign position qualifications"
          onClose={() => setAssignment(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              const selected = qualificationNeeds.find(
                (candidate) => candidate.id === assignmentNeedId,
              );
              if (!selected) return;
              const saved = await updateApplication(
                a.id,
                (application) => ({
                  ...application,
                  hiringNeedId: selected.id,
                  position: selected.position,
                  location: selected.location,
                }),
                true,
              );
              if (saved) setAssignment(false);
            }}
          >
            <p>
              Select the open position whose requirements should be used for
              this applicant. This changes the assigned position and location;
              it does not move the applicant’s stage or send email.
            </p>
            <Field label="Position qualification set">
              <Select
                value={assignmentNeedId}
                onChange={(event) => setAssignmentNeedId(event.target.value)}
                required
              >
                {qualificationNeeds.map((candidate) => {
                  const count = qualificationRulesForPosition(
                    candidate.position,
                    candidate.criteria,
                    state.qualifications,
                  ).length;
                  return (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.position} · {candidate.location} · {count}{" "}
                      requirements
                    </option>
                  );
                })}
              </Select>
            </Field>
            <p className="fine-print">
              If a readable resume is saved, the built-in system analysis runs
              against this set immediately. Unclear evidence stays for HR’s
              checklist review.
            </p>
            <div className="modal-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => setAssignment(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !assignmentNeedId}>
                {saving ? "Assigning…" : "Assign & scan resume"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {a.hiredAt && (
        <Card className="spaced">
          <div className="card-heading">
            <h2>Employment history</h2>
            <StatusBadge status={a.employment?.status || "Active"} />
          </div>
          <div className="padded">
            <p>Hired {formatDate(a.hiredAt, state.preferences)}</p>
            {a.employment && (
              <p>
                {a.employment.status} effective {a.employment.date}
                <br />
                {a.employment.notes}
              </p>
            )}
            <Button
              variant="secondary"
              disabled={!canManage(state.currentUser)}
              onClick={() => setEmployment(true)}
            >
              Update employment status
            </Button>
          </div>
        </Card>
      )}
      {review && (
        <Modal
          busy={saving}
          title="HR evidence review"
          onClose={() => setReview(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const criteria = a.screening.criteria.map((c) => ({
                ...c,
                result: f.get(`result-${c.id}`) as ScreeningCriterion["result"],
                evidence: String(f.get(`evidence-${c.id}`)),
              }));
              if (
                await updateApplication(
                  a.id,
                  (v) => ({
                    ...v,
                    screening: {
                      method: "hr",
                      criteria,
                      completedAt: new Date().toISOString(),
                      outcome: screeningOutcome(criteria),
                    },
                  }),
                  true,
                )
              )
                setReview(false);
            }}
          >
            <p>
              Quote or describe evidence accurately. Use Unclear when there is
              insufficient evidence. This review does not advance or reject the
              applicant.
            </p>
            {a.screening.criteria.map((c) => (
              <div className="rule-editor" key={c.id}>
                <h3>{c.requirement}</h3>
                <Field label="Result">
                  <Select name={`result-${c.id}`} defaultValue={c.result}>
                    <option>Unclear</option>
                    <option>Not Assessed</option>
                    <option>Met</option>
                    <option>Not Met</option>
                  </Select>
                </Field>
                <Field label="Evidence and source">
                  <RichTextEditor
                    name={`evidence-${c.id}`}
                    required
                    defaultValue={c.evidence}
                    rows={3}
                    maxLength={4000}
                  />
                </Field>
              </div>
            ))}
            {!a.screening.criteria.length && (
              <p>
                Configure criteria on the hiring need, then assign it to this
                application.
              </p>
            )}
            <Button
              type="submit"
              disabled={saving || !canManage(state.currentUser)}
            >
              {saving ? "Saving…" : "Confirm HR review"}
            </Button>
          </form>
        </Modal>
      )}
      {employment && (
        <Modal
          busy={saving}
          title="Confirm employment change"
          onClose={() => setEmployment(false)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await updateApplication(
                  a.id,
                  (v) => ({
                    ...v,
                    employment: {
                      status: f.get("status") as
                        "Active" | "Resigned" | "Terminated",
                      date: String(f.get("date")),
                      notes: String(f.get("notes")),
                      actor: state.currentUser?.email || "",
                    },
                  }),
                  true,
                )
              )
                setEmployment(false);
            }}
          >
            <p>
              {a.applicant.name} · {a.position} · {a.location}
            </p>
            <p>
              The original hiring date and recruitment history are preserved.
            </p>
            <Field label="Employment status">
              <Select
                name="status"
                defaultValue={a.employment?.status || "Active"}
              >
                <option>Active</option>
                <option>Resigned</option>
                <option>Terminated</option>
              </Select>
            </Field>
            <Field label="Effective date">
              <Input name="date" type="date" required />
            </Field>
            <Field label="HR notes">
              <RichTextEditor name="notes" rows={3} />
            </Field>
            <Button
              type="submit"
              disabled={saving || !canManage(state.currentUser)}
            >
              {saving ? "Saving…" : "Confirm employment change"}
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
