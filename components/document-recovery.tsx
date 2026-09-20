"use client";
import { useState } from "react";
import type { Application } from "@/types";
import { Button, Modal } from "./ui";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { canEdit } from "@/lib/data-policy";
export function DocumentRecovery({
  application: a,
}: {
  application: Application;
}) {
  const { state, refresh, notify } = useApp();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!a.resumeId || a.isDemo || !a.extraction?.warnings.length) return null;
  return (
    <div className="warning-banner form-stack">
      <strong>Document Processing Issue</strong>
      <p>{a.extraction.warnings.join(" ")}</p>
      <Button
        variant="secondary"
        disabled={!canEdit(state?.currentUser, a) || busy}
        onClick={() => setConfirm(true)}
      >
        Retry Processing
      </Button>
      {confirm && (
        <Modal
          title="Reprocess the original document?"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <div className="form-stack">
            <p>
              This reruns local extraction / OCR on the stored original.
              Verified HR qualification results and recruitment decisions are
              preserved. No Gemini request is made.
            </p>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const r = await requestJson<{ message: string }>(
                      `/api/applicants/${a.id}/processing`,
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ confirmed: true }),
                      },
                    );
                    await refresh();
                    notify(r.message);
                    setConfirm(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Processing document…" : "Retry Processing"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
