"use client";
import { useState, useEffect } from "react";
import { Button, Card, Badge } from "./ui";
import { Intake } from "./intake";
import { useApp } from "./provider";
export function OfficialIntegration() {
  const { notify } = useApp();
  const [status, setStatus] = useState<{
    officialConnected: boolean;
    intakeAuthorized: boolean;
    sheetsConfigured: boolean;
    sheetsConnected: boolean;
  } | null>(null);
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
            The Excel tracker reflects every saved ATS change. Google Sheets
            receives one-way updates when a spreadsheet ID and dedicated tab are
            configured.
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
              onClick={async () => {
                const r = await fetch("/api/integrations/sheets", {
                  method: "POST",
                });
                const d = await r.json();
                notify(d.message || d.error);
              }}
            >
              Retry Sheets sync
            </Button>
          </div>
          <p className="fine-print">
            Google Sheets requires GOOGLE_SHEETS_ID and a dedicated ATS Tracker
            tab. AI screening is not configured; evidence review remains with
            HR.
          </p>
        </div>
      </Card>
    </>
  );
}
