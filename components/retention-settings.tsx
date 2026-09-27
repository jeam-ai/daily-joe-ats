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

type Snapshot = { policies: RetentionPolicies; dryRun: boolean };
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
    name: "activity_log_days",
    label: "Activity history",
    note: "Only old audit events are cleaned; users and settings remain permanent.",
  },
  {
    name: "report_days",
    label: "Saved report snapshots",
    note: "Applies only if historical report snapshots are stored.",
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
            approximately 100. These periods do not limit Gmail intake.
            Permanent deletion is controlled separately by deployment
            verification settings.
          </p>
          {snapshot?.dryRun && (
            <p className="info-banner">
              QA dry run is on: changing a period updates warnings and the
              would-delete preview, but does not permanently delete records.
            </p>
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
