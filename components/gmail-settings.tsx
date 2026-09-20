"use client";
import { clientFetch } from "@/lib/client-request";
import { useEffect, useState } from "react";
import {
  Mail,
  Link2,
  Send,
  Unplug,
  RefreshCw,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { DEFAULT_BODY, DEFAULT_SUBJECT } from "@/lib/google/gmail/payload";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  LoadingSkeleton,
  Modal,
  StatusBadge,
} from "./ui";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import { canManage } from "@/lib/data-policy";
import { Sparkles, Sheet } from "lucide-react";
import {
  OfficialIntegration,
  type IntegrationStatus,
} from "./official-integration";
interface Connection extends IntegrationStatus {
  connected: boolean;
  authenticated: boolean;
  email?: string;
  testRecipient?: string;
  events?: {
    id: string;
    timestamp: string;
    action: string;
    metadata: Record<string, string>;
  }[];
}
export function GmailSettings() {
  const { state, dataset, notify } = useApp();
  const allowed = canManage(state?.currentUser) && dataset === "real";
  const [connection, setConnection] = useState<Connection | null>(null);
  const [recipient, setRecipient] = useState("");
  const [controlledTest, setControlledTest] = useState(false);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [disconnect, setDisconnect] = useState(false);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const response = await clientFetch("/api/integrations/gmail", {
        cache: "no-store",
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Unable to load Gmail status.");
      setConnection(value);
      if (value.testRecipient) setRecipient(value.testRecipient);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error. Try again.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError("");
    setSuccess("");
    try {
      const response = await clientFetch("/api/integrations/gmail/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ to: recipient, subject, body, controlledTest }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Gmail could not confirm the send.");
      setSuccess(
        "Test email sent successfully. Check the recipient inbox to verify delivery.",
      );
      notify("Test email sent successfully.");
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Network error. Check Sent mail before retrying.",
      );
    } finally {
      setSending(false);
    }
  }
  async function remove() {
    setSending(true);
    setError("");
    try {
      const response = await clientFetch("/api/integrations/gmail", {
        method: "DELETE",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDisconnect(false);
      setSuccess("Gmail disconnected from Daily Joe Careers.");
      notify("Gmail disconnected successfully.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to disconnect.");
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="form-stack">
      <OfficialIntegration
        status={connection}
        loading={loading}
        refresh={refresh}
      />
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <Button variant="secondary" disabled={loading} onClick={refresh}>
            Try Again
          </Button>
        </div>
      )}
      <Card>
        <div className="card-heading">
          <div className="integration-title">
            <span className="integration-icon gmail-icon">
              <Mail size={25} />
            </span>
            <div>
              <h2>Personal Gmail test connection</h2>
              <p>
                Personal Gmail test connection for the authenticated HR account.
              </p>
            </div>
          </div>
          <StatusBadge
            status={connection?.connected ? "Gmail Connected" : "Not Connected"}
          />
        </div>
        <div className="padded">
          {loading && !connection ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="key-value">
                <span>Authorized account</span>
                <strong>{connection?.email || "No account connected"}</strong>
              </div>
              <div className="key-value">
                <span>Permission</span>
                <span>Send email only</span>
              </div>
              <div className="inline-actions">
                {!allowed ? (
                  <p className="muted">
                    {dataset === "demo"
                      ? "Exit Demo to manage or test Gmail."
                      : "A recruitment manager can connect and test Gmail."}
                  </p>
                ) : connection?.connected ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => setDisconnect(true)}
                      disabled={sending}
                    >
                      <Unplug size={16} />
                      Disconnect
                    </Button>
                    <a
                      className="button secondary"
                      href="/api/auth/google?flow=gmail"
                    >
                      Reconnect
                    </a>
                  </>
                ) : (
                  <a
                    className="button primary"
                    href={
                      connection?.authenticated
                        ? "/api/auth/google?flow=gmail"
                        : "/login"
                    }
                  >
                    <Link2 size={16} />
                    {connection?.authenticated
                      ? "Connect Gmail"
                      : "Sign in to connect Gmail"}
                  </a>
                )}
                <Button variant="ghost" onClick={refresh} disabled={loading}>
                  <RefreshCw size={15} />
                  Refresh status
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      <Card>
        <div className="card-heading">
          <div>
            <h2>Test Gmail Integration</h2>
            <p>One deliberate email to your designated test address.</p>
          </div>
          <Badge tone="orange">Manual test only</Badge>
        </div>
        <form onSubmit={send} className="padded form-stack">
          {state?.currentUser?.role === "Admin" && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={controlledTest}
                disabled={sending}
                onChange={(e) => {
                  setControlledTest(e.target.checked);
                  if (e.target.checked) setRecipient("deveraajeam@gmail.com");
                }}
              />
              Use the official mailbox for the controlled TEST / DEMO applicant
            </label>
          )}
          {controlledTest && (
            <p className="info-banner">
              Sends only to deveraajeam@gmail.com from the official careers
              mailbox and links the returned Gmail thread to the isolated test
              record. Create that record under System / Demo first.
            </p>
          )}

          <Field label="Test recipient email">
            <Input
              type="email"
              required
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Configured test recipient"
              disabled={sending}
            />
          </Field>
          <p className="field-help">
            The server accepts only your authenticated Google account email for
            this test.
          </p>
          <Field label="Subject">
            <Input
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending}
            />
          </Field>
          <Field label="Message">
            <textarea
              required
              rows={8}
              maxLength={10000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={sending}
            />
          </Field>
          <div className="info-banner">
            <Mail size={18} />
            <span>
              Sending happens only when you click Send Test Email. Login,
              connection, and page refresh never send email.
            </span>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {success && (
            <div className="success-banner" role="status">
              <CheckCircle2 size={19} />
              {success}
            </div>
          )}
          <div className="inline-actions">
            <Button
              disabled={
                !allowed ||
                !(controlledTest
                  ? connection?.officialConnected
                  : connection?.connected) ||
                sending ||
                loading
              }
              type="submit"
            >
              <Send size={16} />
              {sending ? "Sending test email…" : "Send Test Email"}
            </Button>
            {!connection?.connected && (
              <small className="muted">Connect Gmail to enable sending.</small>
            )}
          </div>
        </form>
      </Card>
      <Card>
        <div className="card-heading">
          <div>
            <h2>Integration history</h2>
            <p>Connection and manual test events recorded by the server.</p>
          </div>
        </div>
        <div className="padded">
          {connection?.events?.length ? (
            connection.events.map((e) => (
              <div className="integration-event" key={e.id}>
                <div>
                  <strong>{e.action.replaceAll(".", " · ")}</strong>
                  <small>
                    {formatDate(e.timestamp, state?.preferences, true)}
                  </small>
                </div>
                <span>{e.metadata.recipient || e.metadata.note || ""}</span>
              </div>
            ))
          ) : (
            <p className="muted">No integration events yet.</p>
          )}
        </div>
      </Card>
      <div className="future-integrations">
        <Card>
          <div className="integration-icon sheets-icon">
            <Sheet size={24} />
          </div>
          <h3>Google Sheets</h3>
          <Badge>Available when configured</Badge>
          <p>
            One-way reporting sync. Configure a spreadsheet and authorize Sheets
            above.
          </p>
        </Card>
      </div>
      {disconnect && (
        <Modal
          busy={sending}
          title="Disconnect Gmail?"
          onClose={() => setDisconnect(false)}
        >
          <p>
            This removes stored Gmail tokens from this application. Your Google
            account grant can also be revoked in Google account settings.
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={sending}
              onClick={() => setDisconnect(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} disabled={sending}>
              {sending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
