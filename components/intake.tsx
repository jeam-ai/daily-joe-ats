"use client";
import { useState } from "react";
import { FileText, ScanText } from "lucide-react";
import { useApp } from "./provider";
import { Button, Card, Field, Input, Select, Badge, Modal, Table } from "./ui";
type Row = {
  messageId: string;
  name: string;
  email: string;
  receivedAt: string;
  filename: string;
  mime: string;
  subject: string;
};
type Preview = {
  id: string;
  rows: Row[];
  issues: { message: string; reason: string }[];
  scanned: number;
};
export function Intake() {
  const { state, refresh, notify } = useApp();
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [summary, setSummary] = useState<{
      imported: number;
      skipped: number;
      issues: Preview["issues"];
    } | null>(null);
  const [selection, setSelection] = useState<
    Record<string, { name: string; hiringNeedId: string; selected: boolean }>
  >({});
  if (!state) return null;
  async function request(action: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "preview"
            ? { action }
            : {
                action,
                id: preview?.id,
                confirmed: true,
                selections: Object.entries(selection)
                  .filter(([, v]) => v.selected)
                  .map(([messageId, v]) => ({
                    messageId,
                    name: v.name,
                    hiringNeedId: v.hiringNeedId,
                  })),
              },
        ),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (action === "preview") {
        setPreview(data);
        setSummary(null);
        setSelection(
          Object.fromEntries(
            data.rows.map((r: Row) => [
              r.messageId,
              { name: r.name, hiringNeedId: "", selected: true },
            ]),
          ),
        );
      } else {
        setSummary(data);
        setPreview(null);
        setConfirm(false);
        await refresh();
        notify(`Imported ${data.imported} applicants. ${data.syncStatus}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const count = Object.values(selection).filter((v) => v.selected).length;
  const openNeeds = state.hiringNeeds.filter((n) => n.status === "Open");
  return (
    <Card className="spaced">
      <div className="card-heading">
        <div>
          <h2>Gmail applicant import</h2>
          <p>
            {state.applications.length} / {state.importLimit || 100} applicants
            imported
          </p>
        </div>
        <Badge>Maximum 10 per batch</Badge>
      </div>
      <div className="padded form-stack">
        <p>
          Preview the newest 40 matching application emails from the official
          careers mailbox. Verify each name and map the application to a hiring
          need. Duplicates and unreadable resumes are skipped.
        </p>
        <div className="info-banner">
          <ScanText size={18} aria-hidden="true" />
          <div>
            <strong>Qualification-aware, HR-controlled screening</strong>
            <p>
              PDF/DOCX/TXT text and PNG/JPG OCR are scanned during preview. When
              you map an applicant to a hiring need, direct phrase matches
              against its configured qualifications are saved as evidence.
              Missing or unclear text never auto-rejects an applicant.
            </p>
          </div>
        </div>
        {!openNeeds.length && (
          <div className="info-banner" role="status">
            <FileText size={18} aria-hidden="true" />
            <div>
              <strong>Create an open hiring need before importing.</strong>
              <p>
                It provides the qualifications that the screening review uses.
              </p>
            </div>
          </div>
        )}
        <Button
          disabled={
            busy ||
            !openNeeds.length ||
            state.applications.length >= (state.importLimit || 100)
          }
          onClick={() => void request("preview")}
        >
          {busy ? "Reading Gmail…" : "Preview latest eligible applications"}
        </Button>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {preview && (
          <>
            <p>
              {preview.rows.length} eligible applications · {preview.scanned}{" "}
              messages checked
            </p>
            <Table>
              <thead>
                <tr>
                  <th>Import</th>
                  <th>Applicant</th>
                  <th>Received / attachment</th>
                  <th>Hiring need</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.messageId}>
                    <td>
                      <input
                        aria-label={`Select ${r.name}`}
                        type="checkbox"
                        checked={selection[r.messageId]?.selected || false}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            [r.messageId]: {
                              ...selection[r.messageId],
                              selected: e.target.checked,
                            },
                          })
                        }
                      />
                    </td>
                    <td>
                      <Input
                        aria-label="Verified applicant name"
                        value={selection[r.messageId]?.name || ""}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            [r.messageId]: {
                              ...selection[r.messageId],
                              name: e.target.value,
                            },
                          })
                        }
                      />
                      <small>{r.email}</small>
                      <p>{r.subject}</p>
                    </td>
                    <td>
                      {new Date(r.receivedAt).toLocaleString()}
                      <br />
                      <strong>{r.filename}</strong>
                      <br />
                      <Badge
                        tone={r.mime.startsWith("image/") ? "orange" : "blue"}
                      >
                        {r.mime.startsWith("image/")
                          ? "Image · OCR attempted"
                          : "Text extracted"}
                      </Badge>
                    </td>
                    <td>
                      <Select
                        aria-label={`Hiring need for ${r.name}`}
                        value={selection[r.messageId]?.hiringNeedId || ""}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            [r.messageId]: {
                              ...selection[r.messageId],
                              hiringNeedId: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="">Choose a hiring need</option>
                        {openNeeds.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.position} · {n.location}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Button
              disabled={
                !count ||
                Object.values(selection).some(
                  (v) => v.selected && (!v.name.trim() || !v.hiringNeedId),
                )
              }
              onClick={() => setConfirm(true)}
            >
              Import {count} applicants
            </Button>
            <details>
              <summary>
                {preview.issues.length} skipped / attention items
              </summary>
              {preview.issues.map((i, n) => (
                <p key={n}>
                  {i.message} — {i.reason}
                </p>
              ))}
            </details>
          </>
        )}
        {summary && (
          <div className="info-banner">
            <h3>Import complete</h3>
            <p>
              {summary.imported} imported · {summary.skipped} skipped
            </p>
            <details>
              <summary>Review import details</summary>
              {summary.issues.map((i, n) => (
                <p key={n}>
                  {i.message} — {i.reason}
                </p>
              ))}
            </details>
          </div>
        )}
      </div>
      {confirm && (
        <Modal
          title={`Import ${count} applicants?`}
          onClose={() => setConfirm(false)}
        >
          <p>
            This creates real applicant records and stores their resumes. HR
            will review every application. No email is sent.
          </p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void request("confirm")}>
              {busy ? "Importing…" : `Confirm Import ${count}`}
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
