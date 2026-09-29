"use client";
import { useEffect, useState } from "react";
import {
  retentionPolicyDefaults,
  type RetentionPolicies,
  type RetentionPolicyName,
} from "@/lib/retention-policy";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { Badge, Button, Card, Field, Input } from "./ui";

type Snapshot = {
  policies: RetentionPolicies;
  dryRun: boolean;
  queue?: { retentionPending: number; retentionAwaitingMarker: number };
};
const fields: { name: RetentionPolicyName; label: string; note: string }[] = [
  {
    name: "application_queue_days",
    label: "Outside the newest 500 applications",
    note: "Grace period begins when an unprotected application leaves the live queue.",
  },
  {
    name: "terminal_application_days",
    label: "Rejected, withdrawn, or no-response applications",
    note: "Starts from the application's most recent activity.",
  },
  {
    name: "talent_pool_days",
    label: "Talent Pool membership",
    note: "HR can retain an applicant to restart this period.",
  },
  {
    name: "talent_pool_grace_days",
    label: "Talent Pool grace",
    note: "Additional time after the membership period ends.",
  },
  {
    name: "hiring_need_days",
    label: "Hiring Need after target date",
    note: "Extending the target date recalculates the cleanup deadline.",
  },
  {
    name: "timekeeping_cutoff_grace_days",
    label: "Timekeeping cutoff payroll grace",
    note: "Both monthly cutoff analyses remain through the next month's 5th payroll date plus this grace period (default deletion: the 10th).",
  },
  {
    name: "activity_log_days",
    label: "Activity history",
    note: "Only old audit events are cleaned; users and settings remain permanent.",
  },
  {
    name: "report_days",
    label: "Saved report snapshots",
    note: "Anonymous counts-only snapshots are retained after applicant data is permanently deleted.",
  },
];

export function RetentionSettings() {
  const { state, dataset, notify, refresh } = useApp();
  const admin = state?.currentUser?.role === "Admin";
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [values, setValues] = useState<RetentionPolicies>({
    ...retentionPolicyDefaults,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!admin) {
      setLoading(false);
      return;
    }
    requestJson<Snapshot>("/api/system/retention")
      .then((result) => {
        setSnapshot(result);
        setValues(result.policies);
        setError("");
      })
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setLoading(false));
  }, [admin]);
  return (
    <Card className="padded form-stack">
      <div className="card-heading">
        <div>
          <h2>Data retention periods</h2>
          <p>
            Set how long temporary ATS records remain before cleanup
            eligibility.
          </p>
        </div>
        <Badge tone={snapshot?.dryRun ? "orange" : "green"}>
          {snapshot?.dryRun ? "Dry run" : "Cleanup active"}
        </Badge>
      </div>
      {!admin ? (
        <p>Only an administrator can view or change retention periods.</p>
      ) : (
        <>
          <p className="fine-print">
            Queue size stays at 500 and the active HR view stays at
            approximately 100. These periods do not limit Gmail intake. Before
            permanent applicant deletion, the system writes an anonymous report
            snapshot (date, stage, role, location, source, and count only) for
            the configured report period.
          </p>
          {snapshot?.dryRun && (
            <p className="info-banner">
              QA dry run is on: changing a period updates warnings and the
              would-delete preview, but does not permanently delete records.
            </p>
          )}
          {!!snapshot?.queue?.retentionAwaitingMarker && (
            <p className="fine-print">
              {snapshot.queue.retentionAwaitingMarker} applications are outside
              the live queue but have not yet received a grace-period marker.
              Run a dry-run scan to set their dates without deleting anything.
            </p>
          )}
          {snapshot?.dryRun && (
            <Button
              variant="secondary"
              disabled={saving || loading || dataset === "demo"}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  const result = await requestJson<{
                    wouldDeleteApplications: number;
                  }>("/api/system/retention", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "preview-scan" }),
                  });
                  const latest = await requestJson<Snapshot>(
                    "/api/system/retention",
                  );
                  setSnapshot(latest);
                  await refresh({ clearDetails: true });
                  notify(
                    `Dry-run retention scan complete. ${result.wouldDeleteApplications} applications would be eligible for cleanup; none were deleted.`,
                  );
                } catch (reason) {
                  setError((reason as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Scanning…" : "Run dry-run retention scan"}
            </Button>
          )}
          {!snapshot?.dryRun && (
            <div className="retention-actions">
              <Button
                variant="secondary"
                disabled={saving || loading || dataset === "demo"}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Run eligible retention cleanup now? Only records past their configured deadline will be permanently deleted. Anonymous report counts are retained for the configured report period.",
                    )
                  )
                    return;
                  setSaving(true);
                  setError("");
                  try {
                    const result = await requestJson<{
                      deletedApplications: number;
                      deletedTalentPoolMemberships: number;
                      deletedHiringNeeds: number;
                      archivedAnonymousReportSnapshots: number;
                    }>("/api/system/retention", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "run-cleanup",
                        confirmed: true,
                      }),
                    });
                    const latest = await requestJson<Snapshot>(
                      "/api/system/retention",
                    );
                    setSnapshot(latest);
                    await refresh({ clearDetails: true });
                    notify(
                      `Cleanup complete: ${result.deletedApplications} applicant records, ${result.deletedTalentPoolMemberships} Talent Pool memberships, and ${result.deletedHiringNeeds} hiring needs removed. ${result.archivedAnonymousReportSnapshots} anonymous report snapshots retained.`,
                    );
                  } catch (reason) {
                    setError((reason as Error).message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Cleaning…" : "Run eligible cleanup now"}
              </Button>
              <Button
                variant="danger"
                disabled={
                  saving ||
                  loading ||
                  dataset === "demo" ||
                  !snapshot?.queue?.retentionPending
                }
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Permanently delete every unprotected applicant already in the retention queue now? This bypasses the remaining grace period. Applicant profiles, resumes and contact details will be deleted; anonymous reporting counts will be saved for 365 days.",
                    )
                  )
                    return;
                  setSaving(true);
                  setError("");
                  try {
                    const result = await requestJson<{
                      deletedApplications: number;
                      archivedAnonymousReportSnapshots: number;
                    }>("/api/system/retention", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "purge-queued-applications",
                        confirmed: true,
                      }),
                    });
                    const latest = await requestJson<Snapshot>(
                      "/api/system/retention",
                    );
                    setSnapshot(latest);
                    await refresh({ clearDetails: true });
                    notify(
                      `${result.deletedApplications} queued applicant records permanently deleted. ${result.archivedAnonymousReportSnapshots} anonymous report snapshots retained.`,
                    );
                  } catch (reason) {
                    setError((reason as Error).message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Permanently delete queued applicants
              </Button>
            </div>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <form
            className="form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!snapshot) return;
              if (
                !snapshot.dryRun &&
                fields.some(
                  ({ name }) => values[name] < snapshot.policies[name],
                ) &&
                !window.confirm(
                  "Shorter retention can make existing records eligible for permanent cleanup. Save these changes?",
                )
              )
                return;
              setSaving(true);
              setError("");
              try {
                const result = await requestJson<Snapshot>(
                  "/api/system/retention",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "update-policies",
                      policies: values,
                      confirmShorterRetention: true,
                    }),
                  },
                );
                setSnapshot(result);
                setValues(result.policies);
                await refresh({ clearDetails: true });
                notify(
                  result.dryRun
                    ? "Retention periods saved; warnings recalculated in dry-run mode."
                    : "Retention periods saved; review cleanup eligibility.",
                );
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="form-grid">
              {fields.map(({ name, label, note }) => (
                <Field key={name} label={`${label} (days)`}>
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    required
                    value={values[name]}
                    disabled={loading || saving || dataset === "demo"}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [name]: Number(event.target.value),
                      }))
                    }
                  />
                  <small className="fine-print">{note}</small>
                </Field>
              ))}
            </div>
            <Button
              type="submit"
              disabled={loading || saving || dataset === "demo" || !snapshot}
            >
              {saving ? "Saving…" : "Save retention periods"}
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}
