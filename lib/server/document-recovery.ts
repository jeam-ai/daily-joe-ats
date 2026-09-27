import "server-only";
import { createHash } from "node:crypto";
import type { User } from "@/types";
import { canEdit } from "@/lib/data-policy";
import { unseal, seal } from "@/lib/auth/security";
import { intakeEvidence } from "@/lib/intake-evidence";
import { canonicalizeStoredLocations } from "@/lib/locations";
import { applyRecoveredResumeEvidence } from "@/lib/applicant-information";
import { screenResumeAgainstCriteria, buildInsight } from "@/lib/screening";
import { queueExtraction } from "./ai-extraction";
import { config, SafeError } from "./config";
import {
  readRecord,
  readTransaction,
  transaction,
  putRecord,
} from "./database";
import { recordIssue, reportIssue, resolveIssue } from "./diagnostics";
import { extractResume } from "./documents";
import { getState, saveState, audit } from "./repository";
import { loadResumeBytes } from "./resume-source";

const deferred = (warnings?: string[]) =>
  !!warnings?.some((warning) =>
    /resume processing was deferred/i.test(warning),
  );
const sparse = (warnings?: string[]) =>
  !!warnings?.some((warning) =>
    /very little readable text was extracted/i.test(warning),
  );
const OCR_UPGRADE = "bundled-english-v1";
const EVIDENCE_PARSER_VERSION =
  "residence-preference-clean-education-name-v7";

// Re-evaluate saved text after a deterministic parser improvement. This does
// not fetch Gmail, write files, call AI, or touch HR-verified fields/stages.
export async function refreshStoredEvidenceBatch(limit = 25, onlyId?: string) {
  return transaction(async (tx) => {
    const state = await getState(tx);
    const normalized = canonicalizeStoredLocations(state);
    const processed =
      (await readRecord<Record<string, string>>(
        tx,
        "document_recovery",
        "evidence_parser",
      )) || {};
    const positions = state.hiringNeeds
      .filter((need) => !need.isDemo && need.status === "Open")
      .map((need) => need.position);
    const locations = (state.locations || [])
      .filter((location) => location.active)
      .map((location) => location.name);
    const vocabulary = createHash("sha256")
      .update(
        JSON.stringify([positions.slice().sort(), locations.slice().sort()]),
      )
      .digest("hex")
      .slice(0, 12);
    const candidates = state.applications
      .filter(
        (item) =>
          !item.isDemo &&
          !item.deletedAt &&
          (!!item.resumeId ||
            !!item.gmailMessageId ||
            item.source === "Gmail") &&
          (!onlyId || item.id === onlyId) &&
          processed[item.id] !==
            `${item.resumeId || "email"}:${EVIDENCE_PARSER_VERSION}:${vocabulary}`,
      )
      .slice(0, Math.max(1, Math.min(limit, 25)));
    let updated = normalized;
    for (const application of candidates) {
      processed[application.id] =
        `${application.resumeId || "email"}:${EVIDENCE_PARSER_VERSION}:${vocabulary}`;
      const resume = application.resumeId
        ? (
            await tx.query(
              "SELECT filename,extracted_text FROM resumes WHERE id=$1",
              [application.resumeId],
            )
          )[0]
        : null;
      const text = resume?.extracted_text
        ? unseal<string>(String(resume.extracted_text), config().encryptionKey)
        : "";
      const savedSource = await readRecord<string>(
        tx,
        "application_sources",
        application.id,
      );
      const source = savedSource
        ? unseal<{
            subject: string;
            body: string;
            from: string;
          }>(savedSource, config().encryptionKey)
        : {
            subject: application.originalSubject || "",
            body: "",
            from: application.applicant.email,
          };
      const before = JSON.stringify({
        applicant: application.applicant,
        information: application.information,
        position: application.position,
        location: application.location,
        assignedBranch: application.assignedBranch,
        screening: application.screening,
      });
      applyRecoveredResumeEvidence(
        application,
        intakeEvidence({
          ...source,
          filename: String(resume?.filename || ""),
          resume: text,
          positions,
          locations,
        }),
      );
      if (
        application.screening.method !== "hr" &&
        !application.screening.completedAt
      ) {
        const rules =
          state.hiringNeeds.find((need) => need.id === application.hiringNeedId)
            ?.criteria ||
          state.qualifications.find(
            (template) => template.position === application.position,
          )?.rules ||
          [];
        const criteria = screenResumeAgainstCriteria(
          text,
          rules,
          !application.extraction?.warnings.length,
        );
        application.screening = {
          criteria,
          method: "rules",
          completedAt: "",
          outcome: "Requires Review",
          insight: buildInsight(
            criteria,
            application.position,
            application.location,
            !!text.trim(),
          ),
        };
      }
      if (
        before !==
        JSON.stringify({
          applicant: application.applicant,
          information: application.information,
          position: application.position,
          location: application.location,
          assignedBranch: application.assignedBranch,
          screening: application.screening,
        })
      ) {
        updated++;
        await audit(
          tx,
          "System",
          "application.evidence_parser_refreshed",
          application.id,
          { version: EVIDENCE_PARSER_VERSION },
        );
      }
    }
    if (candidates.length)
      await putRecord(tx, "document_recovery", "evidence_parser", processed);
    if (normalized)
      await audit(tx, "System", "locations.canonicalized", undefined, {
        canonical: "General Trias",
        correctedReferences: normalized,
      });
    if (updated) await saveState(tx, state, { sync: false });
    return { examined: candidates.length, updated };
  });
}

export async function recoverApplicationDocument(
  id: string,
  user?: User,
  loadBytes: typeof loadResumeBytes = loadResumeBytes,
) {
  const actor = user?.email || "System";
  const snapshot = await readTransaction(async (tx) => {
    const state = await getState(tx);
    const application = state.applications.find(
      (item) => item.id === id && !item.deletedAt,
    );
    if (!application) throw new SafeError("Applicant not found.", 404);
    if (application.isDemo || (user && !canEdit(user, application)))
      throw new SafeError(
        "Document processing is unavailable for this record or role.",
        403,
      );
    if (!application.resumeId)
      throw new SafeError("No source resume is attached.");
    const resume = (
      await tx.query("SELECT * FROM resumes WHERE id=$1", [
        application.resumeId,
      ])
    )[0];
    if (!resume) throw new SafeError("Original resume not found.", 404);
    const source = (
      await tx.query(
        "SELECT provider,gmail_message_id,gmail_attachment_id FROM resume_sources WHERE resume_id=$1",
        [application.resumeId],
      )
    )[0];
    const email = await readRecord<string>(tx, "application_sources", id);
    return {
      application,
      resume,
      source,
      email,
      positions: state.hiringNeeds.map((need) => need.position),
      locations: state.locations
        ?.filter((location) => location.active)
        .map((location) => location.name),
    };
  });
  await transaction((tx) =>
    audit(tx, actor, "resume.processing_requested", id, {
      resumeId: snapshot.application.resumeId,
    }),
  );
  const bytes = await loadBytes(snapshot.resume, snapshot.source);
  const document = await extractResume(bytes, String(snapshot.resume.filename));
  const submitted = snapshot.email
    ? unseal<{ subject: string; body: string; from: string; filename: string }>(
        snapshot.email,
        config().encryptionKey,
      )
    : {
        subject: snapshot.application.originalSubject || "",
        body: "",
        from: snapshot.application.applicant.email,
        filename: String(snapshot.resume.filename),
      };
  const evidence = intakeEvidence({
    ...submitted,
    filename: String(snapshot.resume.filename),
    resume: document.text,
    positions: snapshot.positions,
    locations: snapshot.locations,
  });
  await transaction(async (tx) => {
    const state = await getState(tx);
    const application = state.applications.find(
      (item) => item.id === id && !item.deletedAt,
    );
    if (
      !application ||
      application.resumeId !== snapshot.application.resumeId ||
      JSON.stringify(application.screening) !==
        JSON.stringify(snapshot.application.screening) ||
      JSON.stringify(application.extraction) !==
        JSON.stringify(snapshot.application.extraction)
    )
      throw new SafeError(
        "The applicant evidence changed during processing. Refresh before retrying.",
        409,
      );
    await tx.query("UPDATE resumes SET extracted_text=$1 WHERE id=$2", [
      seal(document.text, config().encryptionKey),
      application.resumeId,
    ]);
    application.extraction = document.extraction;
    applyRecoveredResumeEvidence(application, evidence);
    await queueExtraction(tx, application, actor);
    if (
      application.screening.method !== "hr" &&
      !application.screening.completedAt
    ) {
      const rules =
        state.hiringNeeds.find((need) => need.id === application.hiringNeedId)
          ?.criteria ||
        state.qualifications.find(
          (template) => template.position === application.position,
        )?.rules ||
        [];
      const criteria = screenResumeAgainstCriteria(
        document.text,
        rules,
        !document.extraction.warnings.length,
      );
      application.screening = {
        criteria,
        method: "rules",
        completedAt: "",
        outcome: "Requires Review",
        insight: buildInsight(
          criteria,
          application.position,
          application.location,
          !!document.text.trim(),
        ),
      };
    }
    const at = new Date().toISOString();
    application.lastActivity = at;
    application.timeline.push({
      id: crypto.randomUUID(),
      timestamp: at,
      user: actor,
      action: document.extraction.warnings.length
        ? "Document reprocessed — HR review required"
        : "Document processing completed",
      applicationId: id,
      metadata: {
        method: document.extraction.method,
        warnings: document.extraction.warnings.join(" "),
      },
    });
    await audit(tx, actor, "resume.processing_completed", id, {
      resumeId: application.resumeId,
      method: document.extraction.method,
      confidence: document.extraction.confidence,
      warnings: document.extraction.warnings.length,
    });
    if (document.extraction.warnings.length)
      await recordIssue(
        "documents.extraction",
        { entityId: id, user: actor },
        tx,
      );
    await saveState(tx, state, { sync: false });
  });
  if (!document.extraction.warnings.length)
    await resolveIssue("documents.extraction", { entityId: id });
  return document.extraction.warnings.length
    ? "Document reprocessed. Some information still requires HR review."
    : "Document processing completed. Review the recovered applicant details.";
}

// A separate bounded pass processes deferred originals without delaying the
// ten-message Gmail intake batch or copying documents to Drive/PostgreSQL.
export async function recoverOneDeferredDocument(
  recover: (id: string) => Promise<unknown> = (id) =>
    recoverApplicationDocument(id),
) {
  const candidate = await transaction(async (tx) => {
    const state = await getState(tx);
    const attempts = await readRecord<Record<string, number>>(
      tx,
      "document_recovery",
      "retry_at",
    );
    const upgrades =
      (await readRecord<Record<string, string>>(
        tx,
        "document_recovery",
        "ocr_upgrade",
      )) || {};
    const application = state.applications.find(
      (item) =>
        !item.isDemo &&
        !item.deletedAt &&
        item.resumeId &&
        (deferred(item.extraction?.warnings) ||
          (sparse(item.extraction?.warnings) &&
            upgrades[item.id] !== `${item.resumeId}:${OCR_UPGRADE}`)) &&
        (attempts?.[item.id] || 0) <= Date.now(),
    );
    if (!application) return null;
    const next = { ...attempts, [application.id]: Date.now() + 10 * 60000 };
    await putRecord(tx, "document_recovery", "retry_at", next);
    // One bounded upgrade pass for old text-layer failures. Mark before work
    // so a failed original or unreadable PDF cannot loop every minute.
    if (!deferred(application.extraction?.warnings)) {
      upgrades[application.id] = `${application.resumeId}:${OCR_UPGRADE}`;
      await putRecord(tx, "document_recovery", "ocr_upgrade", upgrades);
    }
    return application.id;
  });
  if (!candidate) return false;
  try {
    await recover(candidate);
    await transaction(async (tx) => {
      const attempts =
        (await readRecord<Record<string, number>>(
          tx,
          "document_recovery",
          "retry_at",
        )) || {};
      delete attempts[candidate];
      await putRecord(tx, "document_recovery", "retry_at", attempts);
    });
  } catch (error) {
    if (!(error instanceof SafeError) || error.status >= 500)
      await reportIssue("documents.extraction", { entityId: candidate });
    await transaction(async (tx) => {
      const attempts =
        (await readRecord<Record<string, number>>(
          tx,
          "document_recovery",
          "retry_at",
        )) || {};
      attempts[candidate] = Date.now() + 60 * 60000;
      await putRecord(tx, "document_recovery", "retry_at", attempts);
      await audit(tx, "System", "resume.processing_deferred_retry", candidate, {
        reason:
          error instanceof SafeError ? error.message : "Processing failed",
      });
    });
  }
  return true;
}
