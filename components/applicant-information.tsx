"use client";
import { useEffect, useState } from "react";
import { requestJson } from "@/lib/client-request";
import type { Application } from "@/types";
import { Card, Badge } from "./ui";
import { useApp } from "./provider";
export function ApplicantInformation({
  application: a,
}: {
  application: Application;
}) {
  const { state } = useApp();
  const [extractionError, setExtractionError] = useState("");
  const [extraction, setExtraction] =
    useState<{ status: string; error?: string; createdAt: string }[]>();
  useEffect(() => {
    let live = true;
    requestJson<{
      jobs: { status: string; error?: string; createdAt: string }[];
    }>(`/api/system/extraction?applicant=${encodeURIComponent(a.id)}`)
      .then((d) => {
        if (live) {
          setExtractionError("");
          setExtraction(
            d.jobs.sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
          );
        }
      })
      .catch(() => {
        if (live)
          setExtractionError(
            "Extraction status could not be loaded. Submitted information remains available.",
          );
      });
    return () => {
      live = false;
    };
  }, [a.id, state?.revision]);
  const need = state?.hiringNeeds.find((n) => n.id === a.hiringNeedId);
  const rows = [
    ["name", "Full name", a.applicant.name],
    ["phone", "Phone", a.applicant.phone],
    ["residence", "Residence / address", a.applicant.location],
    ["position", "Applied position", a.position],
    ["location", "Preferred work location", a.location],
    ["education", "Education", a.applicant.education],
    ["availability", "Availability", a.applicant.availability],
    ["experienceDetails", "Experience", a.applicant.experienceDetails],
    ["skills", "Skills", a.applicant.skills],
    ["certifications", "Certifications", a.applicant.certifications],
  ];
  return (
    <Card className="spaced">
      <div className="card-heading">
        <div>
          <h2>Applicant information</h2>
          <p>
            Submitted facts and recruitment assignment are recorded separately.
          </p>
        </div>
      </div>
      <dl className="information-grid">
        {rows.map(([key, label, value]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {value || "Could not be determined"}
              {a.information?.fields[key!] && (
                <>
                  <br />
                  <small className="muted">
                    {a.information.fields[key!].source} ·{" "}
                    {a.information.fields[key!].confidence}
                  </small>
                  <details>
                    <summary>Evidence</summary>
                    <p>{a.information.fields[key!].evidence}</p>
                  </details>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="padded">
        {extraction?.[0] && (
          <p
            className={
              extraction[0].status === "Failed"
                ? "warning-banner"
                : "info-banner"
            }
          >
            AI Integration extraction: {extraction[0].status}.{" "}
            {extraction[0].error ||
              "Evidence-supported clarification only; HR verifies applicant information."}
          </p>
        )}
        {extractionError && <p className="fine-print">{extractionError}</p>}
        <h3>Recruitment assignment</h3>
        <p>{need ? `${need.position} — ${need.location}` : "Unassigned"}</p>
        {a.queueState && <Badge>{a.queueState}</Badge>}
        {!!a.information?.conflicts.length && (
          <div className="warning-banner">
            <strong>Information conflict detected</strong>
            <ul>
              {a.information.conflicts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <p>
              HR should verify the submitted information before relying on it.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
