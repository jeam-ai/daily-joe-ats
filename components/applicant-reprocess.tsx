"use client";
import { useState } from "react";
import type { ExtractionChange } from "@/lib/server/applicant-reprocessing";
import { Button, Modal, Table, Badge } from "./ui";
import { requestJson } from "@/lib/client-request";
import { useApp } from "./provider";
import { BulkActions } from "./bulk-actions";
export function ApplicantReprocess({
  ids,
  disabled,
}: {
  ids: string[];
  disabled?: boolean;
}) {
  const { notify, refresh } = useApp();
  const [preview, setPreview] = useState<{
    id: string;
    changes: ExtractionChange[];
    unavailable: string[];
    checked: number;
  }>();
  const [selected, setSelected] = useState<string[]>([]),
    [overwrite, setOverwrite] = useState(false),
    [busy, setBusy] = useState(false);
  const key = (c: ExtractionChange) => `${c.applicationId}:${c.field}`;
  const eligible =
    preview?.changes.filter((c) => overwrite || !c.protected).map(key) || [];
  async function prepare() {
    setBusy(true);
    try {
      const result = await requestJson<NonNullable<typeof preview>>(
        "/api/applicants/reprocess",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", ids }),
        },
      );
      setPreview(result);
      setOverwrite(false);
      setSelected(
        result.changes
          .filter(
            (c) => !c.protected && c.provenance.confidence === "Confident",
          )
          .map(key),
      );
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled || busy || !ids.length}
        onClick={() => void prepare()}
      >
        {busy
          ? "Reading submitted evidence…"
          : "Reprocess · preview corrections"}
      </Button>
      {preview && (
        <Modal
          title={`Review extraction · ${preview.checked} applicants`}
          busy={busy}
          onClose={() => setPreview(undefined)}
        >
          <p>
            Review the old and proposed values before applying corrections. HR
            edits are protected. Stages, decisions, and source documents are
            preserved.
          </p>
          {preview.unavailable.length > 0 && (
            <p role="status">
              {preview.unavailable.length} applicants have no stored source
              evidence. Reprocess their original documents from the profile.
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={(e) => {
                setOverwrite(e.target.checked);
                if (!e.target.checked)
                  setSelected((ids) =>
                    ids.filter(
                      (id) =>
                        !preview.changes.some(
                          (c) => key(c) === id && c.protected,
                        ),
                    ),
                  );
              }}
            />{" "}
            Allow selected corrections to overwrite protected HR fields
          </label>
          <BulkActions
            count={selected.length}
            total={eligible.length}
            allSelected={
              !!eligible.length && eligible.every((id) => selected.includes(id))
            }
            onSelectAll={() =>
              setSelected(
                eligible.every((id) => selected.includes(id)) ? [] : eligible,
              )
            }
            onClear={() => setSelected([])}
            busy={busy}
          />
          {preview.changes.length ? (
            <div className="reprocess-preview">
              <Table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Applicant / field</th>
                    <th>Current</th>
                    <th>Proposed / evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={key(c)}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Apply ${c.field} correction for ${c.applicantName}`}
                          checked={selected.includes(key(c))}
                          disabled={busy || (c.protected && !overwrite)}
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, key(c)]
                                : ids.filter((id) => id !== key(c)),
                            )
                          }
                        />
                      </td>
                      <td>
                        {c.applicantName}
                        <small className="cell-secondary">{c.field}</small>
                        {c.protected && <Badge>HR protected</Badge>}
                      </td>
                      <td>{c.previous || "Not recorded"}</td>
                      <td>
                        {c.proposed}
                        <small className="cell-secondary">
                          {c.provenance.source} · {c.provenance.confidence}
                        </small>
                        <small>{c.provenance.evidence}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p role="status">No corrections found in the submitted evidence.</p>
          )}
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setPreview(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !selected.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await requestJson<{
                    updated: number;
                    fields: number;
                  }>("/api/applicants/reprocess", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "apply",
                      id: preview.id,
                      selected,
                      overwriteProtected: overwrite,
                      confirmed: true,
                    }),
                  });
                  setPreview(undefined);
                  notify(
                    `${r.fields} corrections applied to ${r.updated} applicants.`,
                  );
                  await refresh({ clearDetails: true });
                } catch (e) {
                  notify((e as Error).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "Applying corrections…"
                : `Confirm ${selected.length} corrections`}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
