"use client";
import { useEffect, useState } from "react";
import { FlaskConical, ShieldCheck, RotateCcw } from "lucide-react";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import { Badge, Button, Card, Modal, LoadingSkeleton, EmptyState } from "./ui";
import { DataMaintenance } from "./data-maintenance";
import { requestJson } from "@/lib/client-request";

export function DemoControls({ banner = false }: { banner?: boolean }) {
  const {
    state,
    refresh,
    notify,
    dataset,
    setDataset,
    demoCount: count,
    hasDemo,
  } = useApp();
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  if (!state) return null;
  const admin = state.currentUser?.role === "Admin";
  async function run(clear: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ message: string }>("/api/demo", {
        method: clear ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(clear ? { body: JSON.stringify({ confirmed: true }) } : {}),
      });
      await refresh();
      setDataset(clear ? "real" : "demo");
      notify(result.message);
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const clearButton = (
    <Button
      variant="ghost"
      disabled={busy || !admin || !hasDemo}
      title={!admin ? "An administrator can clear demo data" : undefined}
      onClick={() => setConfirm(true)}
    >
      Clear Demo Data
    </Button>
  );
  return (
    <>
      {banner ? (
        hasDemo &&
        dataset === "demo" && (
          <div className="demo-banner" role="status">
            <span>
              <FlaskConical size={17} />{" "}
              <strong>
                {dataset === "demo"
                  ? "Demo data is currently displayed."
                  : "Demo data is available in a separate view."}
              </strong>{" "}
              {dataset === "demo"
                ? "Fictional records are labeled DEMO."
                : "Showing real records only."}
            </span>
            <div className="button-row">
              <Button
                variant="secondary"
                onClick={() => setDataset(dataset === "demo" ? "real" : "demo")}
              >
                {dataset === "demo" ? "Exit Demo" : "View Demo"}
              </Button>
              {clearButton}
            </div>
          </div>
        )
      ) : (
        <Card className="padded form-stack">
          <div className="section-heading">
            <h2>
              <FlaskConical size={19} /> System / Demo
            </h2>
            <Badge tone="amber">Controlled demo</Badge>
          </div>
          <p>
            Create five clearly marked fictional applicants and three hiring
            needs to demonstrate the recruitment workflow.
          </p>
          <p className="fine-print">
            Demo records cannot send email or enter the production spreadsheet.
            Real applicants and hiring needs are preserved.
          </p>
          <p>{count} demo applicants currently displayed.</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              role="switch"
              aria-label="Demo mode"
              checked={dataset === "demo"}
              disabled={busy || (!hasDemo && (!admin || !state.demoAvailable))}
              onChange={(e) => {
                if (!e.target.checked) setDataset("real");
                else if (hasDemo) setDataset("demo");
                else void run(false);
              }}
            />
            Demo mode {dataset === "demo" ? "ON" : "OFF"}
          </label>
          <div className="button-row">
            <Button
              disabled={busy || !admin || !state.demoAvailable || hasDemo}
              onClick={() => void run(false)}
            >
              {busy ? "Working…" : "Launch Demo"}
            </Button>
            {clearButton}
          </div>
          {!admin ? (
            <p className="fine-print">Administrator access is required.</p>
          ) : (
            !state.demoAvailable && (
              <p className="fine-print">
                Demo generation is disabled on this deployment. An administrator
                can enable it in the deployment configuration.
              </p>
            )
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </Card>
      )}
      {confirm && (
        <Modal
          title="Clear all demo records?"
          onClose={() => setConfirm(false)}
          busy={busy}
        >
          <div className="form-stack">
            <p>
              This will remove demo applicants, demo hiring needs, demo
              interviews, and demo recruitment activity. Real records will
              remain unchanged.
            </p>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
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
                variant="danger"
                disabled={busy}
                onClick={() => void run(true)}
              >
                {busy ? "Clearing…" : "Clear Demo Data"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function SystemSettings() {
  const { state, dataset } = useApp();
  if (!state) return <LoadingSkeleton />;
  return (
    <div className="form-stack">
      <Card className="padded">
        <h2>Recruitment capacity</h2>
        <p>
          Up to 100 active applicants. Closed, hired, talent-pool and archived
          records remain in history without consuming active capacity. Gmail
          intake resumes as capacity becomes available.
        </p>
      </Card>
      <DemoControls />
      <DataMaintenance />
      {dataset === "real" ? (
        <ArchiveSettings />
      ) : (
        <Card className="padded">
          <h2>Data management</h2>
          <p>Exit Demo to review or restore real applicant records.</p>
        </Card>
      )}
    </div>
  );
}

type Archived = {
  id: string;
  name: string;
  position: string;
  deletedAt: string;
  deletedBy: string;
  reason: string;
};
function ArchiveSettings() {
  const { state, refresh, notify } = useApp();
  const [records, setRecords] = useState<Archived[] | null>(null),
    [error, setError] = useState(""),
    [restoring, setRestoring] = useState<Archived | null>(null),
    [busy, setBusy] = useState(false);
  async function load() {
    setError("");
    try {
      setRecords(
        (await requestJson<{ records: Archived[] }>("/api/applicants")).records,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (state?.currentUser?.role === "Admin") void load();
  }, [state?.currentUser?.role]);
  if (state?.currentUser?.role !== "Admin")
    return (
      <Card className="padded">
        <h2>Data Management</h2>
        <p>
          Administrators can restore deleted applicants. Historical records are
          preserved.
        </p>
      </Card>
    );
  return (
    <Card className="padded form-stack">
      <h2>Data Management</h2>
      <p>
        Deleted applicants are hidden from normal views and exports. Their
        history remains available for restoration.
      </p>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
          <Button variant="secondary" onClick={() => void load()}>
            Try Again
          </Button>
        </div>
      ) : !records ? (
        <LoadingSkeleton />
      ) : !records.length ? (
        <EmptyState
          title="No deleted applicants"
          description="Applicant records that can be restored will appear here."
        />
      ) : (
        records.map((a) => (
          <div className="permission-row" key={a.id}>
            <div>
              <strong>{a.name}</strong>
              <p>
                {a.id} · {a.position}
              </p>
              <small>
                Deleted {formatDate(a.deletedAt, state?.preferences, true)} by{" "}
                {a.deletedBy} · {a.reason}
              </small>
            </div>
            <Button variant="secondary" onClick={() => setRestoring(a)}>
              <RotateCcw size={15} />
              Restore
            </Button>
          </div>
        ))
      )}
      {restoring && (
        <Modal
          title="Restore Applicant?"
          busy={busy}
          onClose={() => setRestoring(null)}
        >
          <div className="form-stack">
            <p>
              {restoring.name} · {restoring.id}
            </p>
            <p>
              The record will return to its previous stage with its audit
              history intact.
            </p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setRestoring(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await requestJson(`/api/applicants/${restoring.id}`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ confirmed: true }),
                    });
                    await refresh();
                    await load();
                    setRestoring(null);
                    notify("Applicant restored successfully.");
                  } catch (e) {
                    notify((e as Error).message, "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Restoring…" : "Restore Applicant"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
