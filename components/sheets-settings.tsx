"use client";
import { useState, useEffect } from "react";
import { Button, Card, Field, Input, Badge, Modal } from "./ui";
import { requestJson, clientFetch } from "@/lib/client-request";
import { useApp } from "./provider";
import type {
  SheetsConfiguration,
  MigrationReport,
} from "@/lib/server/sheets-management";
type Data = {
  configuration: SheetsConfiguration | null;
  connection: { account: string } | null;
  provider: string;
  gatewayConfigured: boolean;
  storageOAuthConfigured: boolean;
  storageAccount: string | null;
  migration: MigrationReport | null;
  job: { status: string; startedAt?: string; error?: string } | null;
};
export function SheetsSettings() {
  const { notify, state } = useApp(),
    [data, setData] = useState<Data>(),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(""),
    [id, setId] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    created: number;
    updated: number;
    unchanged: number;
    issues: string[];
  }>();
  const load = async () => {
    try {
      setData(await requestJson<Data>("/api/data-management"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (data?.job?.status !== "Running") return;
    const timer = setInterval(() => {
      if (
        data.job?.startedAt &&
        Date.now() - Date.parse(data.job.startedAt) > 300000
      ) {
        setData(
          (value) =>
            value && {
              ...value,
              job: { ...value.job!, status: "Interrupted — retry migration" },
            },
        );
        clearInterval(timer);
      } else void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [data?.job?.status, data?.job?.startedAt]);
  const run = async (action: string) => {
    setBusy(action);
    setError("");
    try {
      const result = await requestJson<{
        message?: string;
        status?: string;
        errors?: string[];
      }>("/api/data-management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          id,
          previewId: preview?.id,
          confirmed: true,
        }),
      });
      if (result.errors?.length) throw new Error(result.errors.join(" "));
      notify(
        result.message ||
          result.status ||
          "Data management operation completed.",
      );
      if (action === "confirm-import") setPreview(undefined);
      setConfirm("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const c = data?.configuration,
    admin = state?.currentUser?.role === "Admin";
  if (!admin)
    return (
      <Card className="padded">
        <h2>Google Sheets</h2>
        <p>An administrator manages storage, backups and migration.</p>
      </Card>
    );
  return (
    <Card className="spaced">
      <div className="card-heading">
        <div>
          <h2>Google Sheets & Data Management</h2>
          <p>
            Structured operational records, verified migration and recoverable
            backups.
          </p>
        </div>
        <Badge>{data?.provider || "Checking…"}</Badge>
      </div>
      <div className="padded form-stack">
        {error && (
          <p className="error-banner" role="alert">
            {error}{" "}
            <Button
              variant="secondary"
              onClick={() => void load()}
              disabled={!!busy}
            >
              Retry status
            </Button>
          </p>
        )}
        <dl className="information-grid">
          <div>
            <dt>Connected account</dt>
            <dd>{data?.connection?.account || "Not connected"}</dd>
          </div>
          <div>
            <dt>Spreadsheet</dt>
            <dd>{c?.name || "No workbook selected"}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{c?.schema || "Not checked"}</dd>
          </div>
          <div>
            <dt>Sync direction</dt>
            <dd>
              {data?.provider === "Google Sheets"
                ? "Application ↔ operational Sheets database"
                : "Source database → reviewed Sheets migration"}
            </dd>
          </div>
          <div>
            <dt>Last successful operation</dt>
            <dd>
              {c?.lastSuccess
                ? new Date(c.lastSuccess).toLocaleString()
                : "No successful operation recorded"}
            </dd>
          </div>
          <div>
            <dt>Last failed operation</dt>
            <dd>
              {c?.lastFailure
                ? new Date(c.lastFailure).toLocaleString()
                : "No failure recorded"}
            </dd>
          </div>
          <div>
            <dt>Pending / failed operations</dt>
            <dd>
              {c?.pending ?? "Not recorded"} / {c?.failed ?? "Not recorded"}
            </dd>
          </div>
          <div>
            <dt>Migration</dt>
            <dd>
              {data?.provider === "Google Sheets" && data.migration?.verified
                ? "Verified — Google Sheets is primary"
                : data?.migration?.status || "Not started"}
            </dd>
          </div>
        </dl>
        <div className="button-row">
          <a className="button secondary" href="/api/auth/google?flow=sheets">
            {data?.connection
              ? "Reconnect Google Sheets"
              : "Connect Google Sheets"}
          </a>
          <Button
            disabled={!!busy || !data?.connection || !!c}
            onClick={() => void run("create")}
          >
            {busy === "create"
              ? "Creating workbook…"
              : "Create Careers Workbook"}
          </Button>
        </div>
        <details>
          <summary>Connect an existing spreadsheet</summary>
          <Field label="Spreadsheet ID">
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <p>
            Connecting validates the schema. It does not replace application
            data. Existing records require a reviewed import.
          </p>
          <Button
            disabled={
              !!busy ||
              !id ||
              !data?.connection ||
              data.provider === "Google Sheets"
            }
            onClick={() => setConfirm("connect")}
          >
            Connect Existing Spreadsheet
          </Button>
          {data?.provider === "Google Sheets" && (
            <p>
              Changing the primary workbook requires a verified storage
              migration. Import into the current workbook through a reviewed
              preview.
            </p>
          )}
        </details>
        <div className="button-row">
          {[
            ["test", "Test Connection"],
            ["validate", "Validate Spreadsheet"],
            ["repair", "Repair Structure"],
          ].map(([action, label]) => (
            <Button
              key={action}
              variant="secondary"
              disabled={!!busy || !c}
              onClick={() => void run(action)}
            >
              {busy === action ? "Working…" : label}
            </Button>
          ))}
          <Button
            variant="secondary"
            disabled={!!busy || !c}
            onClick={() =>
              data?.provider === "Google Sheets"
                ? void run("sync")
                : setConfirm("sync")
            }
          >
            Sync Now
          </Button>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={!!busy}
            onClick={async () => {
              setBusy("export");
              try {
                const r = await clientFetch(
                  "/api/data-management?action=export",
                );
                if (!r.ok)
                  throw Error(
                    "Database export failed. Original data is unchanged.",
                  );
                const url = URL.createObjectURL(await r.blob()),
                  link = document.createElement("a");
                link.href = url;
                link.download = `Daily-Joe-Careers-Backup-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                notify("Encrypted database backup exported.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy("");
              }
            }}
          >
            Export Database
          </Button>
          <a className="button secondary" href="/applications">
            Export Current Applications
          </a>
          {c && (
            <a
              className="button secondary"
              target="_blank"
              rel="noreferrer"
              href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(c.id)}/export?format=xlsx`}
            >
              Export Full Workbook
            </a>
          )}
        </div>
        <p className="fine-print">
          Database exports are encrypted and exclude Google session credentials.
          Retain the server encryption key securely to restore encrypted
          documents. Demo records never appear in production recruitment sheets.
        </p>
        <Button
          variant="secondary"
          disabled={!!busy || !c}
          onClick={async () => {
            setBusy("preview");
            setError("");
            try {
              setPreview(
                await requestJson("/api/data-management", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "preview-import" }),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy("");
            }
          }}
        >
          Import Google Sheets — Preview
        </Button>
        {preview && (
          <div className="info-banner form-stack">
            <h3>Import preview</h3>
            <p>
              {preview.created} new · {preview.updated} changed ·{" "}
              {preview.unchanged} unchanged · 0 deleted. Credentials, access
              permissions and background jobs are preserved.
            </p>
            {preview.issues.map((issue, i) => (
              <p key={i}>{issue}</p>
            ))}
            <Button
              disabled={!!busy || !!preview.issues.length}
              onClick={() => setConfirm("confirm-import")}
            >
              Review and Confirm Import
            </Button>
          </div>
        )}
        {!data?.gatewayConfigured && (
          <div className="warning-banner">
            Primary Sheets storage requires the authenticated transaction
            gateway and private document storage. An administrator must complete
            the setup described in <code>docs/SHEETS-MIGRATION.md</code>. The
            current storage remains primary until migration is verified.
          </div>
        )}
        {data?.storageOAuthConfigured && (
          <div className="form-stack">
            <p>
              Private storage account:{" "}
              {data.storageAccount || "Authorization required"}. This connection
              is separate from Gmail and Google sign-in.
            </p>
            <a
              className="button secondary"
              href="/api/auth/google?flow=storage"
            >
              {data.storageAccount
                ? "Reconnect Private Storage"
                : "Authorize Private Storage"}
            </a>
          </div>
        )}
        <Button
          disabled={
            !!busy ||
            data?.provider === "Google Sheets" ||
            !c ||
            !data?.gatewayConfigured ||
            (data.job?.status === "Running" &&
              (!data.job.startedAt ||
                Date.now() - Date.parse(data.job.startedAt) < 300000))
          }
          onClick={() => setConfirm("migrate")}
        >
          {data?.provider === "Google Sheets"
            ? "Migration verified — Sheets active"
            : "Migrate & Verify Source Database"}
        </Button>
        {data?.job && (
          <p role="status">
            Migration job:{" "}
            {data.job.status === "Running" &&
            data.job.startedAt &&
            Date.now() - Date.parse(data.job.startedAt) > 300000
              ? "Interrupted — inspect the migration report and retry"
              : data.job.status}
            . {data.job.error}
          </p>
        )}
        {data?.migration && (
          <details open>
            <summary>Migration report</summary>
            <p>
              {data.migration.read} read · {data.migration.migrated} migrated ·{" "}
              {data.migration.skipped} skipped · {data.migration.review}{" "}
              requiring review · {data.migration.duplicates} duplicates.
            </p>
            <p>
              Verification:{" "}
              {data.migration.verified ? "Passed" : "Not complete"}
            </p>
            {data.migration.errors.map((e, i) => (
              <p className="error-banner" key={i}>
                {e}
              </p>
            ))}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Source</th>
                    <th>Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.migration.counts).map(([name, n]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{n.source}</td>
                      <td>{n.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
      {data?.provider !== "Google Sheets" && data?.migration?.verified && (
        <Button
          variant="secondary"
          disabled={!!busy}
          onClick={() => setConfirm("resume-source")}
        >
          Cancel Cutover & Resume Source
        </Button>
      )}
      {confirm && (
        <Modal
          title={
            confirm === "connect"
              ? "Connect this workbook?"
              : "Review data operation"
          }
          busy={!!busy}
          onClose={() => setConfirm("")}
        >
          <p>
            {confirm === "connect"
              ? "The spreadsheet will become the migration destination. Its structure will be checked before any application records are written."
              : confirm === "resume-source"
                ? "Resume writes to the preserved source workspace? The verified workbook remains untouched. Do not enable Sheets primary until a new migration has been reviewed and verified."
                : confirm === "confirm-import"
                  ? `Import ${preview?.created} new and ${preview?.updated} changed records from ${c?.name}? No records will be deleted. A verified encrypted backup is created first. Audit events cannot be overwritten.`
                  : `Copy the current source records to ${c?.name}? Stable IDs update existing destination rows. The source database will be preserved. Back up and review any manual spreadsheet edits first.`}
          </p>
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() => setConfirm("")}
            >
              Cancel
            </Button>
            <Button disabled={!!busy} onClick={() => void run(confirm)}>
              {busy ? "Working…" : "Confirm"}
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
