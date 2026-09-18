"use client";
import { useState, useEffect } from "react";
import { Button, Card, Badge, Modal } from "./ui";
import { Intake } from "./intake";
import { useApp } from "./provider";
export function OfficialIntegration() {
  const { state, notify } = useApp();
  const [status, setStatus] = useState<{
    officialConnected: boolean;
    intakeAuthorized: boolean;
    sheetsConfigured: boolean;
    sheetsConnected: boolean;
  } | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    fetch("/api/integrations/gmail")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);
  return (
    <>
      <Card>
        <div className="card-heading">
          <div>
            <h2>Official careers mailbox</h2>
            <p>careers@daily-joe.com · Talent Acquisition Specialist</p>
          </div>
          <Badge tone={status?.officialConnected ? "green" : "neutral"}>
            {status?.officialConnected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        <div className="padded form-stack">
          <p>
            Applicant intake and applicant communication use this account.
            Personal Gmail test authorization is separate.
          </p>
          <div className="inline-actions">
            <a className="button primary" href="/api/auth/google?flow=official">
              Connect official Gmail
            </a>
            <a className="button secondary" href="/api/auth/google?flow=intake">
              {status?.intakeAuthorized
                ? "Renew intake authorization"
                : "Authorize applicant intake"}
            </a>
            {status?.officialConnected && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm("Disconnect the official careers mailbox?"))
                    return;
                  const r = await fetch(
                    "/api/integrations/gmail?kind=official",
                    { method: "DELETE" },
                  );
                  if (r.ok)
                    setStatus({
                      ...status,
                      officialConnected: false,
                      intakeAuthorized: false,
                    });
                  else notify((await r.json()).error);
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
          <p className="fine-print">
            Connecting requests Gmail send access. Authorizing intake
            additionally requests Gmail read-only access to preview messages and
            retrieve resumes. Neither action imports records or sends email.
          </p>
        </div>
      </Card>
      <Intake />
      <Card className="spaced">
        <div className="card-heading">
          <h2>Excel / Google Sheets</h2>
          <Badge>
            {status?.sheetsConfigured && status.sheetsConnected
              ? "Configured"
              : "Excel tracker available"}
          </Badge>
        </div>
        <div className="padded form-stack">
          <p>
            The Excel tracker reflects every saved ATS change. When a
            spreadsheet ID and dedicated tab are configured, Google Sheets is
            exported automatically after each saved workspace change.
          </p>
          <div className="inline-actions">
            <a className="button secondary" href="/api/tracker">
              Download Excel tracker
            </a>
            <a className="button secondary" href="/api/auth/google?flow=sheets">
              Authorize Sheets
            </a>
            <Button
              variant="ghost"
              disabled={syncing}
              onClick={() => setConfirmSync(true)}
            >
              {syncing ? "Syncing tracker…" : "Sync tracker now"}
            </Button>
          </div>
          <p className="fine-print">
            Google Sheets requires GOOGLE_SHEETS_ID and a dedicated ATS Tracker
            tab. AI screening is not configured; evidence review remains with
            HR.
          </p>
        </div>
      </Card>
      {confirmSync && (
        <Modal
          title="Export ATS tracker?"
          onClose={() => !syncing && setConfirmSync(false)}
        >
          <div className="export-confirmation">
            <div className="export-confirmation-icon" aria-hidden="true">
              ↗
            </div>
            <p>
              Export the latest saved applications and recruitment updates to
              the connected ATS Tracker sheet. This is a one-way export; your
              workspace remains the source of truth.
            </p>
            <div className="export-progress" aria-live="polite">
              <span>
                {syncing ? "Preparing secure export…" : "Ready to export"}
              </span>
              <strong>{state?.applications.length || 0} applications</strong>
            </div>
          </div>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={syncing}
              onClick={() => setConfirmSync(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  const r = await fetch("/api/integrations/sheets", {
                    method: "POST",
                  });
                  const d = await r.json();
                  notify(d.message || d.error);
                  if (r.ok) setConfirmSync(false);
                } catch {
                  notify("Export failed. Your ATS records are still saved.");
                } finally {
                  setSyncing(false);
                }
              }}
            >
              {syncing ? "Exporting…" : "Confirm & export"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
