"use client";
import { useCallback, useEffect, useState } from "react";
import type { EmailRecord } from "@/types/email";
import { requestJson } from "@/lib/client-request";
import { canManage } from "@/lib/data-policy";
import { useApp } from "./provider";
import { Badge, Button, Card, Modal } from "./ui";

function EmailDetails({
  mail,
  onClose,
  onUpdated,
}: {
  mail: EmailRecord;
  onClose: () => void;
  onUpdated: (m: EmailRecord) => void;
}) {
  const { state, refresh } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function action(action: "retry" | "verify" | "prepare") {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ email: EmailRecord }>(
        `/api/applicants/${mail.applicationId}/emails`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emailId: mail.id, action, confirmed: true }),
        },
      );
      onUpdated(result.email);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Email details" busy={busy} onClose={onClose}>
      <div className="form-stack">
        <Badge>{mail.status}</Badge>
        <dl className="details-grid">
          <dt>From</dt>
          <dd>{mail.sender}</dd>
          <dt>To</dt>
          <dd>{mail.recipient}</dd>
          <dt>Subject</dt>
          <dd>{mail.subject}</dd>
          <dt>Workflow</dt>
          <dd>{mail.workflow}</dd>
          <dt>Template</dt>
          <dd>{mail.templateName}</dd>
          <dt>Created</dt>
          <dd>{new Date(mail.createdAt).toLocaleString()}</dd>
          <dt>Sent</dt>
          <dd>
            {mail.sentAt
              ? new Date(mail.sentAt).toLocaleString()
              : "Not confirmed"}
          </dd>
          <dt>Email reference</dt>
          <dd>{mail.id}</dd>
          {mail.messageId && (
            <>
              <dt>Gmail message</dt>
              <dd>{mail.messageId}</dd>
            </>
          )}
        </dl>
        <pre className="email-body">{mail.body}</pre>
        {mail.error && <div className="warning-banner">{mail.error}</div>}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          {mail.status === "Failed" && canManage(state?.currentUser) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void action("prepare")}
            >
              Refresh email preview
            </Button>
          )}
          {mail.status === "Failed" && canManage(state?.currentUser) && (
            <Button
              disabled={busy || mail.errorCode === "changed"}
              onClick={() => void action("retry")}
            >
              {busy ? "Retrying…" : "Retry failed email"}
            </Button>
          )}
          {mail.status === "Unconfirmed" && canManage(state?.currentUser) && (
            <Button disabled={busy} onClick={() => void action("verify")}>
              {busy ? "Checking Gmail…" : "Verify in Gmail"}
            </Button>
          )}
          {mail.threadId && /^[a-zA-Z0-9_-]+$/.test(mail.threadId) && (
            <a
              className="button secondary"
              href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mail.sender)}#all/${mail.threadId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Gmail
            </a>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function ViewEmail({
  applicationId,
  emailId,
}: {
  applicationId: string;
  emailId: string;
}) {
  const [mail, setMail] = useState<EmailRecord | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await requestJson<{ emails: EmailRecord[] }>(
              `/api/applicants/${applicationId}/emails`,
            );
            const m = r.emails.find((m) => m.id === emailId);
            if (!m) throw Error("Email details are unavailable.");
            setMail(m);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening…" : "View Email"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {mail && (
        <EmailDetails
          mail={mail}
          onClose={() => setMail(null)}
          onUpdated={setMail}
        />
      )}
    </>
  );
}
export function EmailHistory({ applicationId }: { applicationId: string }) {
  const { state } = useApp();
  const [emails, setEmails] = useState<EmailRecord[]>([]),
    [selected, setSelected] = useState<EmailRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await requestJson<{ emails: EmailRecord[] }>(
        `/api/applicants/${applicationId}/emails`,
      );
      setEmails(result.emails);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applicationId]);
  useEffect(() => {
    void load();
  }, [load, state?.revision]);
  useEffect(() => {
    if (!emails.some((m) => m.status === "Queued" || m.status === "Sending"))
      return;
    const id = setTimeout(() => void load(), 5000);
    return () => clearTimeout(id);
  }, [emails, load]);
  return (
    <Card className="spaced">
      <div className="card-heading">
        <div>
          <h2>Email history</h2>
          <p>Saved messages and confirmed Gmail delivery status.</p>
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load();
          }}
        >
          Refresh
        </Button>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : busy ? (
        <p className="padded" role="status">
          Loading email history…
        </p>
      ) : !emails.length ? (
        <p className="padded">No workflow emails recorded yet.</p>
      ) : (
        <ul className="email-history">
          {emails.map((m) => (
            <li key={m.id}>
              <div>
                <strong>{m.subject}</strong>
                <p>
                  {m.workflow} · {new Date(m.createdAt).toLocaleString()}
                </p>
              </div>
              <Badge>{m.status}</Badge>
              <Button variant="ghost" onClick={() => setSelected(m)}>
                View Email
              </Button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <EmailDetails
          mail={selected}
          onClose={() => setSelected(null)}
          onUpdated={(m) => {
            setSelected(m);
            void load();
          }}
        />
      )}
    </Card>
  );
}
