"use client";
import { useState } from "react";
import type { Application } from "@/types";
import { renderTemplate } from "@/lib/recruitment";
import { useApp } from "./provider";
import { Button, Card, Field, Input, Select, Modal, Badge } from "./ui";
export function Communication({
  application: a,
}: {
  application: Application;
}) {
  const { state, refresh, notify } = useApp();
  const [open, setOpen] = useState(false),
    [template, setTemplate] = useState(""),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [reply, setReply] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<{
      id: string;
      to: string;
      subject: string;
      body: string;
      threadId?: string;
    } | null>(null);
  if (!state) return null;
  const templates = state.emailTemplates;
  function choose(id: string) {
    setTemplate(id);
    const t = templates.find((t) => t.id === id)!;
    const interview = a.interviews.at(-1);
    const values = {
      applicant_name: a.applicant.name,
      position: a.position,
      location: a.location,
      company_name: "Daily Joe",
      interview_date: interview
        ? new Date(interview.scheduledAt).toLocaleDateString()
        : "[date]",
      interview_time: interview
        ? new Date(interview.scheduledAt).toLocaleTimeString()
        : "[time]",
    };
    setSubject(renderTemplate(t.subject, values));
    setBody(renderTemplate(t.body, values));
    setDraft(null);
  }
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/communications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "preview"
            ? {
                action,
                applicationId: a.id,
                templateId: template,
                subject,
                body,
                reply,
              }
            : { action, id: draft?.id, confirmed: true },
        ),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      if (action === "preview") setDraft(d.draft);
      else {
        setOpen(false);
        setDraft(null);
        await refresh();
        notify(d.message);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="spaced">
      <div className="card-heading">
        <h2>Communication</h2>
      </div>
      <div className="padded">
        <p>
          Prepare a message from careers@daily-joe.com, review it, then
          explicitly confirm sending.
        </p>
        <Button
          disabled={
            state.currentUser?.role === "Viewer" ||
            state.currentUser?.role === "Office Assistant"
          }
          onClick={() => {
            choose(
              templates.find(
                (t) =>
                  t.name === (a.status === "Rejected" ? "Rejection" : a.stage),
              )?.id || templates[0].id,
            );
            setError("");
            setOpen(true);
          }}
        >
          Compose email
        </Button>
      </div>
      {open && (
        <Modal
          title={draft ? "Confirm Send" : "Prepare applicant email"}
          onClose={() => !busy && setOpen(false)}
        >
          {draft ? (
            <div className="form-stack">
              <Badge>
                {draft.threadId
                  ? "Reply in application thread"
                  : "New conversation"}
              </Badge>
              <p>
                <b>From:</b> careers@daily-joe.com
              </p>
              <p>
                <b>To:</b> {draft.to}
              </p>
              <p>
                <b>Subject:</b> {draft.subject}
              </p>
              <pre className="email-preview">{draft.body}</pre>
              <p>Sending delivers this message to the real applicant.</p>
              <div className="modal-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  Back to edit
                </Button>
                <Button disabled={busy} onClick={() => void act("send")}>
                  {busy ? "Sending…" : "Confirm Send"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="form-stack">
              <Field label="Email template">
                <Select
                  value={template}
                  onChange={(e) => choose(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <p>Recipient: {a.applicant.email}</p>
              <Field label="Subject">
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
              <Field label="Message">
                <textarea
                  rows={10}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
              {a.rfcMessageId && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={reply}
                    onChange={(e) => setReply(e.target.checked)}
                  />
                  Reply in existing application thread (keeps original subject)
                </label>
              )}
              <Button disabled={busy} onClick={() => void act("preview")}>
                {busy ? "Preparing…" : "Preview email"}
              </Button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}
