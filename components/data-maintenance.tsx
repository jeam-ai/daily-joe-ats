"use client";
import { useState } from "react";
import { useApp } from "./provider";
import { Button, Card, Modal } from "./ui";
import { requestJson } from "@/lib/client-request";
export function DataMaintenance() {
  const { state, dataset, refresh, notify } = useApp();
  const [action, setAction] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState("");
  if (state?.currentUser?.role !== "Admin" || dataset === "demo") return null;
  async function run() {
    setBusy(true);
    setError("");
    try {
      if (action === "enrich") {
        const ids = state!.applications
          .filter((a) => !a.isDemo && !!a.gmailMessageId)
          .map((a) => a.id);
        let changed = 0;
        for (let i = 0; i < ids.length; i += 5) {
          setProgress(
            `Reviewing ${i + 1}–${Math.min(i + 5, ids.length)} of ${ids.length}`,
          );
          const r = await requestJson<{ updated: number }>("/api/system", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ids: ids.slice(i, i + 5) }),
          });
          changed += r.updated;
        }
        notify(`Evidence reprocessed. ${changed} applicant records updated.`);
      } else {
        await requestJson("/api/system", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        notify(
          action === "sample-config"
            ? "Sample configurations are ready for review."
            : "Controlled test applicant is available in Demo Mode.",
        );
      }
      await refresh();
      setAction("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  return (
    <Card className="padded form-stack">
      <h2>Configuration & evidence maintenance</h2>
      <p>
        Sample hiring needs remain paused until an authorized HR user reviews
        and activates them. Reprocessing uses submitted Gmail and resume
        evidence and preserves recorded HR decisions.
      </p>
      <div className="button-row">
        <Button
          variant="secondary"
          onClick={() => {
            setError("");
            setAction("sample-config");
          }}
        >
          Add missing sample configurations
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setError("");
            setAction("enrich");
          }}
        >
          Reprocess existing Gmail evidence
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setError("");
            setAction("test-applicant");
          }}
        >
          Create controlled test applicant
        </Button>
      </div>
      {action && (
        <Modal
          title={
            action === "enrich"
              ? "Reprocess submitted evidence?"
              : action === "sample-config"
                ? "Add sample configurations?"
                : "Create TEST / DEMO applicant?"
          }
          busy={busy}
          onClose={() => setAction("")}
        >
          <div className="form-stack">
            <p>
              {action === "enrich"
                ? "This reads existing source emails and resumes in small batches, fills unverified position/location fields where evidence is explicit, and refreshes unreviewed System Analysis. No AI requests or emails are sent. Completed HR assessments and recruitment decisions are preserved."
                : action === "sample-config"
                  ? "Add only missing sample position qualifications and paused hiring needs. Existing configured rules remain unchanged."
                  : "Create one isolated TEST / DEMO record for Jeam De Vera at the designated test address. It is excluded from real recruitment and spreadsheets. This action sends no email."}
            </p>
            {progress && <p role="status">{progress}</p>}
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setAction("")}
              >
                Cancel
              </Button>
              <Button disabled={busy} onClick={run}>
                {busy ? "Working…" : "Confirm"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
