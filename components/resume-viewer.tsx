"use client";
import { useEffect, useState } from "react";
import type { Application } from "@/types";
import { Button, EmptyState } from "./ui";
export function ResumeViewer({ application: a }: { application: Application }) {
  const [text, setText] = useState(""),
    [filename, setFilename] = useState(""),
    [mime, setMime] = useState(""),
    [error, setError] = useState(""),
    [mode, setMode] = useState("document"),
    [zoom, setZoom] = useState(100);
  useEffect(() => {
    if (!a.resumeId) return;
    let alive = true;
    fetch(`/api/resumes/${a.resumeId}?text=1`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (alive) {
          setText(data.text);
          setFilename(data.filename);
          setMime(data.mime || "");
        }
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [a.resumeId]);
  if (!a.resumeId)
    return (
      <EmptyState
        title="No resume attached"
        description="A resume will appear after a confirmed Gmail import."
      />
    );
  return (
    <div className="real-resume">
      <div className="resume-toolbar">
        <strong>{filename || "Loading resume…"}</strong>
        <Button
          variant="ghost"
          onClick={() => setMode(mode === "document" ? "text" : "document")}
        >
          {mode === "document" ? "Extracted text" : "Document"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setZoom(Math.max(75, zoom - 10))}
          aria-label="Zoom out"
        >
          −
        </Button>
        <span>{zoom}%</span>
        <Button
          variant="ghost"
          onClick={() => setZoom(Math.min(175, zoom + 10))}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button variant="ghost" onClick={() => setZoom(100)}>
          Fit
        </Button>
        <a href={`/api/resumes/${a.resumeId}`} target="_blank" rel="noreferrer">
          Open original
        </a>
      </div>
      {error ? (
        <div className="error-banner">{error}</div>
      ) : mode === "document" && mime.startsWith("image/") ? (
        <div className="resume-image-wrap">
          <img
            src={`/api/resumes/${a.resumeId}`}
            alt={`Resume of ${a.applicant.name}`}
            className="resume-image"
            style={{ transform: `scale(${zoom / 100})` }}
          />
          <p className="fine-print">Image resume · OCR review required</p>
        </div>
      ) : mode === "document" && /\.pdf$/i.test(filename) ? (
        <iframe
          title={`Resume of ${a.applicant.name}`}
          src={`/api/resumes/${a.resumeId}#zoom=${zoom}`}
          className="resume-frame"
        />
      ) : (
        <pre className="resume-text" style={{ fontSize: (14 * zoom) / 100 }}>
          {text || "Loading resume text…"}
        </pre>
      )}
      <p className="fine-print">
        Imported resume ·{" "}
        {mode === "document" && mime.startsWith("image/")
          ? "Original image; add evidence during HR review."
          : mode === "document" && /\.pdf$/i.test(filename)
            ? "Use the PDF toolbar for pages and scrolling."
            : "Extracted text; formatting may differ from the original."}
      </p>
    </div>
  );
}
