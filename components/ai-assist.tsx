"use client";
import { useEffect, useState } from "react";
import { Info, Sparkles } from "lucide-react";
import type { AiProfile } from "@/types/operations";
import { requestJson } from "@/lib/client-request";
import { Button, Card, Badge, Modal } from "./ui";
import Link from "next/link";
const explanation =
  "AI Assist provides an additional interpretation of the applicant’s submitted information. It does not replace System Analysis, make hiring decisions, rank applicants, or automatically advance an application.";
export function AiAssist({ id }: { id: string }) {
  const [data, setData] = useState<AiProfile>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const load = () =>
    requestJson<AiProfile>(`/api/applicants/${id}/ai`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError("");
    requestJson<AiProfile>(`/api/applicants/${id}/ai`)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    if (data?.run?.status !== "Running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await requestJson<AiProfile>(`/api/applicants/${id}/ai`);
        if (stopped) return;
        setData(next);
        if (next.run?.status === "Running") timer = setTimeout(poll, 3000);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    timer = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, data?.run?.id, data?.run?.status]);
  async function action(action: string, fresh = false) {
    setBusy(true);
    setError("");
    try {
      setData(
        await requestJson<AiProfile>(`/api/applicants/${id}/ai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, fresh, confirmed: true }),
        }),
      );
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const run = data?.run,
    result = run?.result;
  return (
    <Card>
      <div className="card-heading">
        <div>
          <div className="eyebrow">OPTIONAL SECOND OPINION</div>
          <h2>
            <Sparkles size={18} /> AI Assist
          </h2>
        </div>
        <div className="button-row">
          <label className="checkbox-label">
            <input
              type="checkbox"
              role="switch"
              aria-label="AI Assist"
              checked={!!data?.enabled}
              disabled={
                !data?.configured ||
                !data.canRun ||
                busy ||
                run?.status === "Running"
              }
              onChange={(e) => {
                if (e.target.checked) setConfirm(true);
                else void action("disable");
              }}
            />
            {data?.enabled ? "ON" : "OFF"}
          </label>
          <span className="info-tooltip" tabIndex={0} aria-label={explanation}>
            <Info size={18} />
            <span role="tooltip">{explanation}</span>
          </span>
        </div>
      </div>
      <div className="padded form-stack">
        <p className="muted">
          System Analysis is the built-in qualification engine. AI Assist adds
          an optional interpretation; HR verifies the evidence and makes every
          decision.
        </p>
        {!data && !error && <p role="status">Loading AI Assist status…</p>}
        {error && (
          <div className="error-banner" role="alert">
            {error}{" "}
            <Button variant="secondary" disabled={busy} onClick={load}>
              Retry status
            </Button>
          </div>
        )}
        {data && !data.configured && (
          <p className="info-banner">
            AI Assist is unavailable. System Analysis is still available.{" "}
            <Link href="/settings/ai">AI Integration settings</Link>
          </p>
        )}
        {!!data?.eligible.length && (
          <div>
            <Badge>AI Assist Available</Badge>
            <p className="fine-print">
              {data.eligible.join(" · ")}. No request runs automatically.
            </p>
          </div>
        )}
        {data?.stale && (
          <p className="warning-banner">
            Applicant information has changed since this AI result. Re-run
            explicitly to review the current evidence.
          </p>
        )}
        {run?.status === "Failed" && (
          <p className="error-banner" role="alert">
            {run.error}
          </p>
        )}
        {run?.status === "Running" && !busy && (
          <p role="status">
            An AI request is in progress.{" "}
            <Button variant="secondary" onClick={load}>
              Check request status
            </Button>
          </p>
        )}
        <div className="button-row">
          <Button
            disabled={
              !data?.configured ||
              !data.canRun ||
              busy ||
              run?.status === "Running"
            }
            onClick={() => setConfirm(true)}
          >
            {busy
              ? "Analyzing application…"
              : run?.status === "Failed"
                ? "Retry AI Assist"
                : result
                  ? "Re-run AI Analysis"
                  : "Run AI Assist"}
          </Button>
          {data?.enabled && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => action("disable")}
            >
              Turn off AI Assist
            </Button>
          )}
        </div>
        {data && !data.canRun && (
          <p className="fine-print">
            A real applicant, readable extracted document, and permission to
            edit this applicant are required.
          </p>
        )}
        {result && (
          <div className="ai-result form-stack">
            <Badge>AI-generated · Verify against the original</Badge>
            <p>{result.summary}</p>
            {!!result.clarifiedInformation.length && (
              <div>
                <h3>Potential clarification</h3>
                {result.clarifiedInformation.map((c, i) => (
                  <div key={i}>
                    <p>
                      <strong>{c.field}:</strong> {c.interpretation}
                    </p>
                    <blockquote>{c.evidence}</blockquote>
                  </div>
                ))}
              </div>
            )}
            {!!result.experience.length && (
              <div>
                <h3>Experience interpretation</h3>
                {result.experience.map((c, i) => (
                  <div key={i}>
                    <p>{c.interpretation}</p>
                    <blockquote>{c.evidence}</blockquote>
                  </div>
                ))}
              </div>
            )}
            {[
              ["Uncertainty", result.uncertainties],
              ["Conflicting information", result.conflicts],
              ["Items for HR to verify", result.verify],
            ].map(
              ([title, items]) =>
                (items as string[]).length > 0 && (
                  <div key={String(title)}>
                    <h3>{String(title)}</h3>
                    <ul>
                      {(items as string[]).map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
            <p className="fine-print">
              {run?.provider} · {run?.model} · Requested by {run?.requestedBy} ·{" "}
              {run?.completedAt &&
                new Date(run.completedAt).toLocaleString("en-PH", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
            </p>
          </div>
        )}
      </div>
      {confirm && (
        <Modal
          title={result ? "Re-run AI Analysis?" : "Run AI Assist?"}
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <div className="form-stack">
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            <p>
              This sends available extracted resume text, applied position and
              location, and qualification evidence to Google Gemini for an
              additional interpretation. The source document may contain
              personal information. Qualification results and application
              decisions remain unchanged.
            </p>
            <p>
              One explicit request will be made. Saved results are reused when
              the source has not changed, unless you choose to re-run.
            </p>
            <div className="modal-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => action("run", !!result)}>
                {busy ? "Analyzing application…" : "Run AI Assist"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
