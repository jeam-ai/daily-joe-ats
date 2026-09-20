"use client";
import { useState } from "react";
import type { Application, ScreeningCriterion } from "@/types";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import { Sparkles } from "lucide-react";
import { canManage, canEdit } from "@/lib/data-policy";
import { ScreeningControls } from "./screening-controls";
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
export function ApplicantTools({
  application: a,
}: {
  application: Application;
}) {
  const { state, updateApplication, saving } = useApp();
  const [employment, setEmployment] = useState(false),
    [review, setReview] = useState(false);
  if (!state) return null;
  const need = state.hiringNeeds.find((n) => n.id === a.hiringNeedId);
  const directMatches = a.screening.criteria.filter(
    (criterion) => criterion.result === "Met",
  ).length;
  const needsReview = a.screening.criteria.filter((criterion) =>
    ["Unclear", "Not Assessed"].includes(criterion.result),
  ).length;
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
          <p>
            {a.screening.insight ||
              "Review the resume against the qualifications configured for this hiring need. Unstated information remains unclear."}
          </p>
          <div className="inline-actions spaced">
            <Badge tone={directMatches ? "green" : "orange"}>
              Qualification match:{" "}
              {a.screening.criteria.length
                ? Math.round(
                    (directMatches / a.screening.criteria.length) * 100,
                  ) + "%"
                : "Not assessed"}
            </Badge>
            <span className="fine-print">
              {directMatches} of {a.screening.criteria.length} configured
              qualifications met. MET ÷ all configured criteria; unclear and
              unassessed criteria do not count as met. Informational only.
            </span>
            <Badge tone={needsReview ? "orange" : "green"}>
              {needsReview}{" "}
              {needsReview === 1 ? "criterion needs" : "criteria need"} review
            </Badge>
          </div>
          <p className="fine-print">
            OCR and text matching are advisory. They do not approve, reject, or
            advance an applicant.
          </p>
          <details className="evidence-details">
            <summary>Evidence used</summary>
            <ul>
              {a.screening.criteria.map((c) => (
                <li key={c.id}>
                  <strong>{c.requirement}</strong>
                  <p>{c.evidence}</p>
                </li>
              ))}
            </ul>
          </details>
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
          {need?.questions && (
            <>
              <h3>Interview reference questions</h3>
              <pre className="reference-questions">{need.questions}</pre>
              <p>Record the applicant’s actual answers in interview notes.</p>
            </>
          )}
        </div>
      </Card>
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
                      outcome:
                        criteria.some((c) =>
                          ["Unclear", "Not Assessed"].includes(c.result),
                        ) || !criteria.length
                          ? "Requires Review"
                          : criteria.some((c) => c.result === "Not Met")
                            ? "Criteria Not Met"
                            : "Meets Criteria",
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
                  <textarea
                    name={`evidence-${c.id}`}
                    required
                    defaultValue={c.evidence}
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
              <textarea name="notes" />
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
