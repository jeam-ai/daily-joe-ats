"use client";
import { useEffect, useState } from "react";
import type { Application } from "@/types";
import { Button, EmptyState, LoadingSkeleton, Badge, Field } from "./ui";
import { requestJson } from "@/lib/client-request";
import { canEdit } from "@/lib/data-policy";
import { useApp } from "./provider";
export function ResumeViewer({ application: a }: { application: Application }) {
  const { state, refresh, notify } = useApp();
  const [document, setDocument] = useState<{
    text: string;
    filename: string;
    mime: string;
    extraction?: Application["extraction"];
  } | null>(null);
  const [error, setError] = useState(""),
    [mode, setMode] = useState("document"),
    [zoom, setZoom] = useState(100),
    [retry, setRetry] = useState(0),
    [uploading, setUploading] = useState(false);
  useEffect(() => {
    setDocument(null);
    setError("");
    if (!a.resumeId) return;
    const controller = new AbortController();
    requestJson<NonNullable<typeof document>>(
      `/api/resumes/${a.resumeId}?text=1`,
      { signal: controller.signal },
    )
      .then(setDocument)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [a.resumeId, retry]);
  if (a.isDemo && !a.resumeId)
    return (
      <div className="padded form-stack">
        <Badge tone="amber">DEMO DOCUMENT SUMMARY</Badge>
        <h3>{a.applicant.name}</h3>
        <p>
          Example Coffee — {a.position}. Fictional customer-facing experience
          used to demonstrate the qualification checklist.
        </p>
        <p className="fine-print">
          This is fictional demonstration evidence. No real resume has been
          uploaded.
        </p>
      </div>
    );
  if (!a.resumeId)
    return (
      <div>
        <EmptyState
          title="No resume attached"
          description="Upload PDF, DOCX, PNG, JPG/JPEG, or TXT. Maximum 8 MB."
        />
        {canEdit(state?.currentUser, a) && (
          <form
            className="padded form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setUploading(true);
              setError("");
              try {
                await requestJson(`/api/applicants/${a.id}/resume`, {
                  method: "POST",
                  body: form,
                });
                await refresh();
                notify(
                  "Resume uploaded successfully. Review the extraction evidence.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setUploading(false);
              }
            }}
          >
            <Field label="Resume file">
              <input
                className="input"
                name="resume"
                type="file"
                accept=".pdf,.docx,.png,.jpg,.jpeg,.txt"
                required
                disabled={uploading}
              />
            </Field>
            <Button type="submit" disabled={uploading}>
              {uploading ? "Reading document…" : "Upload Resume"}
            </Button>
          </form>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  if (error)
    return (
      <div className="padded form-stack">
        <div className="error-banner" role="alert">
          {error}
        </div>
        <Button variant="secondary" onClick={() => setRetry(retry + 1)}>
          Try Again
        </Button>
      </div>
    );
  if (!document) return <LoadingSkeleton />;
  const extraction = document.extraction;
  return (
    <div className="real-resume">
      <div className="resume-toolbar">
        <strong>{document.filename}</strong>
        <Button
          variant="ghost"
          onClick={() => setMode(mode === "document" ? "text" : "document")}
        >
          {mode === "document" ? "Extracted text" : "Document"}
        </Button>
        <Button
          variant="ghost"
          disabled={zoom <= 75}
          onClick={() => setZoom(Math.max(75, zoom - 10))}
          aria-label="Zoom out"
        >
          −
        </Button>
        <span>{zoom}%</span>
        <Button
          variant="ghost"
          disabled={zoom >= 175}
          onClick={() => setZoom(Math.min(175, zoom + 10))}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button variant="ghost" onClick={() => setZoom(100)}>
          Fit
        </Button>
        <a
          className="text-link"
          href={`/api/resumes/${a.resumeId}`}
          target="_blank"
          rel="noreferrer"
        >
          Open original
        </a>
      </div>
      {extraction && (
        <div className="extraction-status">
          <Badge tone={extraction.warnings.length ? "amber" : "green"}>
            {extraction.method === "text" ? "Text extracted" : "OCR processed"}
            {extraction.confidence !== undefined
              ? ` · ${extraction.confidence}% OCR confidence`
              : ""}
          </Badge>
          {extraction.pages && <span>{extraction.pages} pages</span>}
          {extraction.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {mode === "document" && document.mime.startsWith("image/") ? (
        <div className="resume-image-wrap">
          <img
            src={`/api/resumes/${a.resumeId}`}
            alt={`Resume of ${a.applicant.name}`}
            className="resume-image"
            style={{ transform: `scale(${zoom / 100})` }}
          />
        </div>
      ) : mode === "document" && document.mime === "application/pdf" ? (
        <iframe
          loading="lazy"
          title={`Resume of ${a.applicant.name}`}
          src={`/api/resumes/${a.resumeId}#zoom=${zoom}`}
          className="resume-frame"
        />
      ) : (
        <pre className="resume-text" style={{ fontSize: (14 * zoom) / 100 }}>
          {document.text ||
            "No reliable text could be extracted. Review the original document and record evidence manually."}
        </pre>
      )}
      <p className="fine-print padded">
        Extracted text and OCR may differ from the original. OCR confidence
        describes text recognition, not applicant qualifications.
      </p>
    </div>
  );
}
