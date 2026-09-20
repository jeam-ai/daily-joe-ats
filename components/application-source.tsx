"use client";
import { useEffect } from "react";
import type { Application } from "@/types";
import { requestJson } from "@/lib/client-request";
import { Badge, Button, Card } from "./ui";
export function ApplicationSource({
  application: a,
}: {
  application: Application;
}) {
  useEffect(() => {
    void requestJson(`/api/applicants/${a.id}/activity`, {
      method: "POST",
    }).catch(() => {});
  }, [a.id]);
  const message = a.gmailThreadId || a.gmailMessageId;
  const link =
    message && /^[a-f0-9]+$/i.test(message)
      ? `https://mail.google.com/mail/?authuser=${encodeURIComponent("careers@daily-joe.com")}#all/${encodeURIComponent(message)}`
      : undefined;
  return (
    <Card className="spaced">
      <div className="card-heading">
        <h2>Application Source</h2>
        <Badge>{a.isDemo ? "DEMO DATA" : a.source || "Manual"}</Badge>
      </div>
      <div className="padded form-stack">
        <p>
          <strong>Submitted position:</strong> {a.position}
          <br />
          <strong>Preferred work location:</strong> {a.location}
          <br />
          <strong>Residence:</strong> {a.applicant.location || "Not verified"}
        </p>
        {a.gmailMessageId && (
          <p>
            <strong>Mailbox:</strong> careers@daily-joe.com
            <br />
            <strong>Subject:</strong> {a.originalSubject || "Not recorded"}
            <br />
            <strong>Received:</strong>{" "}
            {new Date(a.appliedAt).toLocaleString("en-PH", {
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        )}
        {link ? (
          <a
            className="button secondary"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            View Application in Gmail
          </a>
        ) : (
          <div>
            <Button variant="secondary" disabled>
              View Application in Gmail
            </Button>
            <p className="fine-print">
              {a.isDemo
                ? "Demo applicants have no real Gmail message."
                : "No original Gmail message reference is available for this record."}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
