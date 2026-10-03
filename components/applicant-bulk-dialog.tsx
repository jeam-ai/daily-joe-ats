"use client";
import { useState } from "react";
import { useApp } from "./provider";
import { Button, Field, Input, Select, Modal } from "./ui";
import { requestJson, downloadFile } from "@/lib/client-request";
import { scheduledIso } from "@/lib/dates";
import { RichTextContent } from "./rich-text";
type EmailPreview = {
  id: string;
  name: string;
  recipient: string;
  stage: string;
  nextStage?: string;
  subject?: string;
  body?: string;
  error?: string;
};
export function ApplicantBulkDialog({
  action,
  ids,
  allFiltered,
  filters,
  onClose,
  onDone,
}: {
  action: string;
  ids: string[];
  allFiltered: boolean;
  filters: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { state, notify, refresh } = useApp();
  const [reason, setReason] = useState(""),
    [value, setValue] = useState(""),
    [scheduledAt, setScheduledAt] = useState(""),
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<EmailPreview[]>();
  const [requestId] = useState(() => crypto.randomUUID());
  const [revision] = useState(state?.revision);
  const labels: Record<string, string> = {
    proceed: "Move to next stage",
    reject: "Reject",
    withdraw: "Withdraw",
    talent: "Move to talent pool",
    status: "Change status",
    assign: "Assign hiring need",
    note: "Add note",
    delete: "Delete",
    export: "Export selected",
  };
  const label = labels[action] || action;
  if (!state) return null;
  const payload = {
    requestId,
    ids,
    allFiltered,
    filters,
    revision,
    action,
    reason,
    value,
    scheduledAt: scheduledAt
      ? scheduledIso(scheduledAt, state.preferences.timezone)
      : undefined,
    confirmed: true,
    typedConfirmation: typed,
  };
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  return (
    <Modal
      title={`${label} · ${ids.length} applicants`}
      busy={busy}
      onClose={onClose}
    >
      <p>
        {ids.length} selected applicants across all pages will receive this
        action. Each record keeps its own audit history.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {action === "assign" && (
        <Field label="Hiring need">
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose an open hiring need</option>
            {state.hiringNeeds
              .filter((n) => n.status === "Open")
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.position} · {n.location}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {action === "status" && (
        <Field label="Status">
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose status</option>
            {[
              "New",
              "For Review",
              "Approved",
              "In Progress",
              "No Response",
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Reason / note">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {action === "delete" && (
        <Field label={`Type DELETE ${ids.length} to confirm deletion`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
          <small>
            Applicants are soft deleted and can be restored by an administrator.
          </small>
        </Field>
      )}
      {action === "proceed" && (
        <>
          <Field label="Interview schedule (when entering an interview stage)">
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => {
                setScheduledAt(e.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await requestJson<{ preview: EmailPreview[] }>(
                  "/api/applicants/bulk",
                  {
                    ...options,
                    body: JSON.stringify({ ...payload, action: "preview" }),
                  },
                );
                setPreview(r.preview);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Preview stage changes and emails
          </Button>
          <div className="reprocess-preview">
            {preview?.map((p) => (
              <details key={p.id}>
                <summary>
                  {p.name} · {p.stage} → {p.nextStage || "Needs attention"}
                </summary>
                {p.error ? (
                  <p className="error-banner">{p.error}</p>
                ) : (
                  <>
                    <p>To: {p.recipient}</p>
                    <strong>{p.subject}</strong>
                    <RichTextContent value={p.body || ""} />
                  </>
                )}
              </details>
            ))}
          </div>
          <p>
            Confirming queues the reviewed stage emails. Each stage advances
            after successful email delivery, using the existing workflow.
          </p>
        </>
      )}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            busy ||
            (action === "delete" && typed !== `DELETE ${ids.length}`) ||
            (action === "proceed" && (!preview || preview.some((p) => p.error)))
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (action === "export")
                await downloadFile(
                  "/api/applicants/bulk",
                  "Daily-Joe-selected-applicants.xlsx",
                  options,
                );
              else {
                const r = await requestJson<{
                  updated: number;
                  emailIds: string[];
                }>("/api/applicants/bulk", options);
                notify(
                  `${r.updated} applicants updated${r.emailIds.length ? `; ${r.emailIds.length} stage emails queued` : ""}.`,
                );
                await refresh({ clearDetails: true });
              }
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Applying bulk action…"
            : action === "proceed"
              ? "Confirm & send stage emails"
              : `Confirm ${label.toLowerCase()}`}
        </Button>
      </div>
    </Modal>
  );
}
