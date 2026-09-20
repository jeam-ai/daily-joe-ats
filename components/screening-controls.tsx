"use client";
import { useState } from "react";
import type { Application } from "@/types";
import { requestJson } from "@/lib/client-request";
import { canManage } from "@/lib/data-policy";
import { useApp } from "./provider";
import { Button, Modal } from "./ui";
export function ScreeningControls({
  application: a,
}: {
  application: Application;
}) {
  const { state, refresh, notify } = useApp();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ready =
    !a.isDemo &&
    !!a.resumeId &&
    !!(
      state?.hiringNeeds.find((n) => n.id === a.hiringNeedId)?.criteria
        ?.length ||
      state?.qualifications.find((q) => q.position === a.position)?.rules
        ?.length
    ) &&
    canManage(state?.currentUser);
  return (
    <div className="form-stack spaced">
      <Button
        variant="secondary"
        disabled={!ready || busy}
        onClick={() => setConfirm(true)}
      >
        Run System Analysis
      </Button>
      <p className="fine-print">
        {ready
          ? "Uses the built-in qualification engine. No AI request is made."
          : "Requires a resume, configured position qualifications, and recruitment manager access."}
      </p>
      {confirm && (
        <Modal
          title="Refresh System Analysis?"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <div className="form-stack">
            <p>
              This compares the extracted resume with the assigned hiring need.
              Existing assessment values remain in Audit History. HR remains
              responsible for verification and decisions.
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
                    await requestJson(`/api/applicants/${a.id}/resume`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ confirmed: true }),
                    });
                    await refresh();
                    notify("System Analysis updated. Review the evidence.");
                    setConfirm(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Analyzing…" : "Run System Analysis"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
