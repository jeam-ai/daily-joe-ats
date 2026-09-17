"use client";
import { useState } from "react";
import type { Application, ScreeningCriterion } from "@/types";
import { useApp } from "./provider";
import { Button, Card, Field, Input, Select, Modal, StatusBadge } from "./ui";
export function ApplicantTools({
  application: a,
}: {
  application: Application;
}) {
  const { state, updateApplication } = useApp();
  const [employment, setEmployment] = useState(false),
    [review, setReview] = useState(false);
  if (!state) return null;
  const need = state.hiringNeeds.find((n) => n.id === a.hiringNeedId);
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
                <option value="HR Queen">HR Queen</option>
                <option value="HR Jeam">HR Jeam</option>
                <option value="HR Ellaine">HR Ellaine</option>
              </Select>
            </Field>
          </div>
        </Card>
      )}
      <Card className="spaced">
        <div className="card-heading">
          <h2>System Insight</h2>
        </div>
        <div className="padded">
          <p>
            Resume received through Gmail.{" "}
            {a.screening.criteria.filter((c) => c.result === "Unclear").length}{" "}
            criteria need HR verification. Availability, experience, and
            interview answers must be confirmed from evidence.
          </p>
          <p className="fine-print">
            AI is not configured. No AI assessment or hiring decision has been
            made.
          </p>
          <Button variant="secondary" onClick={() => setReview(true)}>
            Record evidence review
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
            <p>Hired {new Date(a.hiredAt).toLocaleDateString()}</p>
            {a.employment && (
              <p>
                {a.employment.status} effective {a.employment.date}
                <br />
                {a.employment.notes}
              </p>
            )}
            <Button variant="secondary" onClick={() => setEmployment(true)}>
              Update employment status
            </Button>
          </div>
        </Card>
      )}
      {review && (
        <Modal title="HR evidence review" onClose={() => setReview(false)}>
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
                      criteria,
                      completedAt: new Date().toISOString(),
                      outcome:
                        criteria.some((c) => c.result === "Unclear") ||
                        !criteria.length
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
            <Button type="submit">Confirm HR review</Button>
          </form>
        </Modal>
      )}
      {employment && (
        <Modal
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
            <Button type="submit">Confirm employment change</Button>
          </form>
        </Modal>
      )}
    </>
  );
}
