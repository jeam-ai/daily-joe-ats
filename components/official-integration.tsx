"use client";
import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { downloadFile, requestJson } from "@/lib/client-request";
import { canManage } from "@/lib/data-policy";
import { Button, Card, Badge, Modal, LoadingSkeleton } from "./ui";
import { Intake } from "./intake";
import { useApp } from "./provider";
export interface IntegrationStatus {
  officialConnected?: boolean;
  officialError?: string;
  officialStored?: boolean;
  requiresReconnect?: boolean;
  intakeAuthorized?: boolean;
  sheetsConfigured?: boolean;
  sheetsConnected?: boolean;
  aiConfigured?: boolean;
}
export function OfficialIntegration({
  status,
  loading,
  refresh,
}: {
  status: IntegrationStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}) {
  const { state, notify, dataset } = useApp();
  const [confirmation, setConfirmation] = useState<
    "disconnect" | "sync" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const allowed = canManage(state?.currentUser);
  const real = dataset === "real";
  async function act() {
    setBusy(true);
    try {
      if (confirmation === "disconnect") {
        await requestJson("/api/integrations/gmail?kind=official", {
          method: "DELETE",
        });
        notify("Official Gmail disconnected.");
      } else {
        const result = await requestJson<{ message: string }>(
          "/api/integrations/sheets",
          { method: "POST" },
        );
        notify(result.message || "Spreadsheet synchronized.");
      }
      setConfirmation(null);
      await refresh();
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Card>
        <div className="card-heading">
          <div>
            <h2>Daily Joe Careers</h2>
            <p>careers@daily-joe.com</p>
          </div>
          <Badge tone={status?.officialConnected ? "green" : "neutral"}>
            {loading && !status
              ? "Checking…"
              : !status
                ? "Status unavailable"
                : status.officialConnected
                  ? "Connected"
                  : "Not connected"}
          </Badge>
        </div>
        <div className="padded form-stack">
          <p>
            Applicant intake and recruitment emails use the official careers
            account. Personal Gmail testing has a separate connection.
          </p>
          {loading && !status ? (
            <LoadingSkeleton />
          ) : allowed && real ? (
            <div className="inline-actions">
              {(!status?.officialStored ||
                status?.requiresReconnect ||
                !status?.intakeAuthorized) && (
                <a
                  className="button primary"
                  href="/api/auth/google?flow=official"
                >
                  {status?.officialError
                    ? "Reconnect official Gmail"
                    : "Connect official Gmail"}
                </a>
              )}
              <Button
                variant="secondary"
                disabled={busy || loading}
                onClick={() => void refresh()}
              >
                Check connection
              </Button>
              {status?.officialStored && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmation("disconnect")}
                >
                  Disconnect
                </Button>
              )}
            </div>
          ) : (
            <p className="muted">
              {!real
                ? "Exit Demo to manage production integrations."
                : "A recruitment manager can manage this connection."}
            </p>
          )}
          {status?.officialError && (
            <p className="error-banner" role="alert">
              {status.officialError}
            </p>
          )}
          <p className="fine-print">
            Connecting authorizes read-only intake and sending from this
            mailbox. Automatic intake reads matching applications after
            connection. Recruitment emails still require an explicit HR action.
          </p>
        </div>
      </Card>
      {real ? (
        <Intake
          authorized={!!status?.intakeAuthorized && !!status.officialConnected}
        />
      ) : (
        <Card className="padded">
          <h2>Applicant intake</h2>
          <p>
            Importing Gmail applications is disabled while viewing demo data.
          </p>
        </Card>
      )}
      <Card className="spaced">
        <div className="card-heading">
          <h2>Excel / Google Sheets</h2>
          <Badge>
            {status?.sheetsConfigured && status.sheetsConnected
              ? "Connected"
              : "Excel tracker available"}
          </Badge>
        </div>
        <div className="padded form-stack">
          <p>
            The tracker includes active real records. Demo and deleted
            applicants are excluded from all production exports.
          </p>
          <div className="inline-actions">
            <Button
              variant="secondary"
              disabled={busy || !real}
              onClick={async () => {
                setBusy(true);
                try {
                  await downloadFile(
                    "/api/tracker",
                    "Daily-Joe-Careers-Tracker.xlsx",
                  );
                  notify("Excel tracker downloaded.");
                } catch (e) {
                  notify((e as Error).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Download size={16} />
              {busy && !confirmation ? "Preparing…" : "Download Excel tracker"}
            </Button>
            {allowed && real && (
              <a
                className="button secondary"
                href="/api/auth/google?flow=sheets"
              >
                {status?.sheetsConnected
                  ? "Renew Sheets authorization"
                  : "Authorize Sheets"}
              </a>
            )}
            <Button
              variant="ghost"
              disabled={
                busy ||
                state?.currentUser?.role !== "Admin" ||
                !real ||
                !status?.sheetsConnected ||
                !status.sheetsConfigured
              }
              onClick={() => setConfirmation("sync")}
            >
              <RefreshCw size={16} />
              Sync tracker now
            </Button>
          </div>
          <p className="fine-print">
            {!real
              ? "Exit Demo to export real recruitment records."
              : !status?.sheetsConfigured || !status.sheetsConnected
                ? "Ask an administrator to configure the tracker destination and authorize Google Sheets to enable synchronization."
                : "Saved recruitment changes synchronize with the dedicated ATS Tracker tab."}
          </p>
        </div>
      </Card>
      {confirmation && (
        <Modal
          busy={busy}
          title={
            confirmation === "disconnect"
              ? "Disconnect official Gmail?"
              : "Synchronize spreadsheet?"
          }
          onClose={() => setConfirmation(null)}
        >
          <p>
            {confirmation === "disconnect"
              ? "This removes the saved authorization for the official careers mailbox. Reconnect to resume importing applications and sending recruitment emails."
              : "Export the latest saved real applications and recruitment updates to the connected ATS Tracker sheet. This is a one-way export; Daily Joe Careers remains the source of truth."}
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              variant={confirmation === "disconnect" ? "danger" : "primary"}
              disabled={busy}
              onClick={act}
            >
              {busy
                ? "Working…"
                : confirmation === "disconnect"
                  ? "Disconnect Gmail"
                  : "Confirm & synchronize"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
