"use client";
import { useEffect, useState } from "react";
import { requestJson } from "@/lib/client-request";
import type { Application } from "@/types";
import { Card, Badge } from "./ui";
import { Button } from "./ui";
import { Pencil } from "lucide-react";
import { useApp } from "./provider";
import {
  applicantDisplayName,
  missingInformation,
} from "@/lib/applicant-information";
import { formalFact } from "@/lib/formal-facts";
export function ApplicantInformation({
  application: a,
  editable = false,
  onEdit,
}: {
  application: Application;
  editable?: boolean;
  onEdit?: () => void;
}) {
  const { state } = useApp();
  const [extractionError, setExtractionError] = useState("");
  const [retrying, setRetrying] = useState(false);
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
  const branchMatchedFromResidence =
    a.information?.fields.assignedBranch?.source === "Residence match";
  const rows = [
    ["name", "Full name", applicantDisplayName(a)],
    ["email", "Email", a.applicant.email],
    ["phone", "Phone", a.applicant.phone],
    ["residence", "Residence / address", a.applicant.location],
    ["position", "Applied position", a.position],
    ["location", "Preferred work location", a.location],
    ["education", "Education", a.applicant.education],
    ["availability", "Availability", a.applicant.availability],
    ["experienceDetails", "Experience", a.applicant.experienceDetails],
    ["skills", "Skills", a.applicant.skills],
    ["certifications", "Certifications", a.applicant.certifications],
  ] as const;
  const sections = [
    {
      title: "Identity & contact",
      description: "Who the applicant is and how to reach them.",
      rows: rows.slice(0, 4),
    },
    {
      title: "Application preferences",
      description: "The role and work location explicitly requested.",
      rows: rows.slice(4, 6),
    },
    {
      title: "Background & qualifications",
      description: "Submitted education, experience, skills, and credentials.",
      rows: rows.slice(6),
    },
  ];
  const incomplete = rows.filter(([, , value]) => missingInformation(value));
  const confirmed = rows.length - incomplete.length;
  const listItems = (value: string) => [
    ...new Set(
      value
        .split(/\n|[;•]|,\s*(?=\p{L})/u)
        .map((item) => item.replace(/^[-–]\s*/, "").trim())
        .filter(Boolean),
    ),
  ];
  const structuredItems = (value: string) =>
    value
      .split(/\s+·\s+|\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
  const educationItem = (item: string) => {
    const formatted = formalFact("education", item);
    const dated = /^(.*?)\s*[—–-]\s*(\d{4}–(?:\d{4}|Present))$/.exec(formatted);
    const [title, ...details] = (dated?.[1] || formatted)
      .split(/\s+·\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return (
      <span className="education-record">
        <strong>{title}</strong>
        {!!details.length && (
          <span className="education-details">{details.join(" · ")}</span>
        )}
        {dated && <span className="information-period">{dated[2]}</span>}
      </span>
    );
  };
  const display = (key: string, value?: string) => {
    if (missingInformation(value)) {
      const latestStatus = extraction?.[0]?.status;
      if (latestStatus === "Queued" || latestStatus === "Running")
        return "Scanning submitted resume, email, and subject…";
      if (latestStatus === "Completed")
        return "Undetected after resume, email, subject, and final AI review.";
      if (latestStatus === "Failed")
        return "Automatic review could not confirm this field. Complete it manually if known.";
      return key === "position"
        ? "Applied position was not clearly stated in the submission."
        : key === "location"
          ? "Preferred work location was not clearly stated."
          : key === "residence"
            ? "Residence was not clearly stated in submitted information."
            : "Not clearly stated in submitted information";
    }
    const normalized = formalFact(key, value!);
    return key === "experienceDetails" &&
      !/[.!?]$/.test(normalized) &&
      !normalized.includes("\n")
      ? `${normalized}.`
      : normalized;
  };
  return (
    <Card className="spaced applicant-information">
      <div className="card-heading">
        <div>
          <h2>Applicant information</h2>
          <p>
            Submitted facts and recruitment assignment are recorded separately.
          </p>
        </div>
        {onEdit && (
          <Button
            variant="secondary"
            onClick={onEdit}
            disabled={!editable}
            aria-label="Edit applicant information"
          >
            <Pencil size={15} /> Edit
          </Button>
        )}
      </div>
      <div className="profile-coverage" aria-live="polite">
        <div>
          <strong>
            Profile coverage: {confirmed} of {rows.length} fields found
          </strong>
          <p>
            Built-in detection checks the resume first, then the email body and
            subject only for remaining gaps.
          </p>
        </div>
        <Badge>
          {incomplete.length ? `${incomplete.length} to review` : "Complete"}
        </Badge>
      </div>
      {!!incomplete.length && (
        <p className="profile-coverage-note">
          Needs review: {incomplete.map(([, label]) => label).join(", ")}. You
          can complete these fields manually without waiting for AI fallback.
        </p>
      )}
      <div className="information-sections">
        {sections.map((section) => (
          <section className="information-section" key={section.title}>
            <div className="information-section-heading">
              <h3>{section.title}</h3>
              <p>{section.description}</p>
            </div>
            <dl className="information-grid">
              {section.rows.map(([key, label, value]) => (
                <div
                  className={`information-item information-item-${key}`}
                  key={key}
                >
                  <dt>{label}</dt>
                  <dd
                    className={
                      missingInformation(value)
                        ? "information-empty"
                        : undefined
                    }
                  >
                    {(key === "skills" || key === "certifications") &&
                    !missingInformation(value) ? (
                      <ul className="information-list">
                        {listItems(value!).map((item) => (
                          <li key={item}>{formalFact(key, item)}</li>
                        ))}
                      </ul>
                    ) : (key === "education" || key === "experienceDetails") &&
                      !missingInformation(value) &&
                      structuredItems(value!).length > 1 &&
                      structuredItems(value!).length <= 10 ? (
                      <ul className="information-list">
                        {structuredItems(value!).map((item, index) => (
                          <li key={`${index}-${item}`}>
                            {key === "education"
                              ? educationItem(item)
                              : formalFact(key, item)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>{display(key, value)}</span>
                    )}
                    {a.information?.fields[key] && (
                      <>
                        <small className="muted information-source">
                          {a.information.fields[key].source} ·{" "}
                          {a.information.fields[key].confidence}
                        </small>
                        <details>
                          <summary>Evidence</summary>
                          <p>{a.information.fields[key].evidence}</p>
                        </details>
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="padded">
        {extraction?.[0] && (
          <div
            className={
              extraction[0].status === "Failed"
                ? "warning-banner"
                : "info-banner"
            }
          >
            <p>
              AI Assist extraction: {extraction[0].status}.{" "}
              {extraction[0].error ||
                "Evidence-supported clarification only; HR verifies applicant information."}
            </p>
            {extraction[0].status === "Failed" && editable && (
              <Button
                variant="secondary"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  setExtractionError("");
                  try {
                    await requestJson("/api/system/extraction", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        retry: true,
                        applicationId: a.id,
                      }),
                    });
                    setExtraction((current) =>
                      current?.map((job, index) =>
                        index === 0
                          ? { ...job, status: "Queued", error: undefined }
                          : job,
                      ),
                    );
                  } catch (error) {
                    setExtractionError((error as Error).message);
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                {retrying ? "Queuing retry…" : "Retry AI fallback"}
              </Button>
            )}
          </div>
        )}
        {extractionError && <p className="fine-print">{extractionError}</p>}
        <section
          className="recruitment-assignment"
          aria-label="Recruitment assignment"
        >
          <div>
            <h3>Recruitment assignment</h3>
            <p>
              Operational assignment stays separate from submitted preferences.
            </p>
          </div>
          <div className="assignment-facts">
            <p>
              <strong>Hiring need</strong>
              <span>
                {need ? `${need.position} — ${need.location}` : "Unassigned"}
              </span>
            </p>
            <p>
              <strong>Assigned branch</strong>
              <span>{a.assignedBranch || "Unassigned"}</span>
              {branchMatchedFromResidence && (
                <small>
                  Auto-assigned because the submitted residence matches this
                  configured location.
                </small>
              )}
            </p>
          </div>
        </section>
        {a.editedAt && (
          <p className="fine-print">
            Edited by {a.editedBy} · {new Date(a.editedAt).toLocaleString()}
          </p>
        )}
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
