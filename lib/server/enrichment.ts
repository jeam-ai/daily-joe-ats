import { evidenceInformation } from "@/lib/applicant-information";
import { queueExtraction } from "./ai-extraction";
import { recordIssue } from "./diagnostics";
import "server-only";
import type {
  Application,
  HiringNeed,
  QualificationTemplate,
  User,
} from "@/types";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
} from "./database";
import { getState, saveState, audit } from "./repository";
import { SafeError, config } from "./config";
import { seal, unseal } from "@/lib/auth/security";
import { intakeEvidence, messageBody } from "@/lib/intake-evidence";
import { gmail, official } from "@/lib/google/gmail/intake";
import { accessToken } from "@/lib/google/gmail/service";
import { screenResumeAgainstCriteria, buildInsight } from "@/lib/screening";

export function sampleQualifications(): QualificationTemplate[] {
  return ["Barista", "Team Leader", "Supervisor", "Other"].map((position) => {
    const labels =
      position === "Barista"
        ? [
            "1 year barista experience",
            "Customer service experience",
            "Available for shifting schedule",
            "High school graduate or equivalent",
          ]
        : position === "Team Leader"
          ? [
              "Team leadership experience",
              "Customer service experience",
              "Available for shifting schedule",
            ]
          : position === "Supervisor"
            ? [
                "Supervisory experience",
                "Staff scheduling experience",
                "Customer service experience",
              ]
            : [];
    return {
      id: position,
      position,
      minimum: labels.join("\n"),
      preferred: "",
      criteria:
        "Sample configuration — review against your actual job requirements.",
      questions:
        "Confirm unclear qualifications and work-location preference during HR review.",
      rules: labels.map((label, i) => ({
        id: `sample-${position.toLowerCase().replaceAll(" ", "-")}-${i}`,
        label,
        kind: "Minimum",
        absenceFails: false,
      })),
    };
  });
}
export async function installSampleConfiguration(user: User) {
  if (user.role !== "Admin")
    throw new SafeError("Administrator access required.", 403);
  return transaction(async (tx) => {
    const state = await getState(tx);
    let count = 0;
    for (const template of sampleQualifications()) {
      const existing = state.qualifications.find(
        (q) => q.position === template.position,
      );
      if (!existing) {
        state.qualifications.push(template);
        count++;
      } else if (
        !existing.rules?.length &&
        !existing.minimum &&
        !existing.preferred &&
        !existing.criteria
      ) {
        Object.assign(existing, { ...template, id: existing.id });
        count++;
      }
    }
    state.locations ||= [];
    if (!state.locations.some((l) => l.name === "Other")) {
      state.locations.push({
        id: "other",
        name: "Other",
        city: "Other",
        province: "",
        active: true,
      });
      count++;
    }
    for (const [index, position, location] of [
      ["1", "Barista", "Naga City"],
      ["2", "Barista", "Santa Rosa, Laguna"],
      ["3", "Team Leader", "Naga City"],
    ]) {
      const id = `sample-need-${index}`;
      if (state.hiringNeeds.some((n) => n.id === id)) continue;
      const template = state.qualifications.find(
        (q) => q.position === position,
      );
      const need: HiringNeed = {
        id,
        position,
        location,
        status: "Paused",
        slots: 1,
        filled: 0,
        urgency: "Medium",
        targetDate: "",
        criteria: template?.rules,
        qualifications:
          "SAMPLE CONFIGURATION — review and activate only when a real vacancy is authorized.",
        questions: template?.questions || "",
      };
      state.hiringNeeds.push(need);
      count++;
    }
    if (count) {
      await audit(
        tx,
        user.email,
        "settings.sample_configuration_installed",
        undefined,
        {
          count,
          source: "User",
          note: "Paused sample hiring needs; no applicants or production vacancies created.",
        },
      );
      await saveState(tx, state, { sync: false });
    }
    return { updated: count };
  });
}
interface EmailSource {
  subject: string;
  body: string;
  from: string;
  filename: string;
}
// Explicit, bounded backfill. It never overwrites verified HR assessments or
// stages, links a sample vacancy, sends mail, or invokes an AI provider.
export async function enrichApplicants(user: User, ids: string[]) {
  if (user.role !== "Admin")
    throw new SafeError("Administrator access required.", 403);
  if (!ids.length || ids.length > 10)
    throw new SafeError("Choose 1–10 applicants per enrichment batch.");
  const snapshot = await readTransaction(getState);
  let token: string | undefined;
  const prepared: {
    id: string;
    text: string;
    source: EmailSource;
    evidence: ReturnType<typeof intakeEvidence>;
    before: Application;
  }[] = [];
  for (const id of ids) {
    const a = snapshot.applications.find(
      (v) => v.id === id && !v.isDemo && !v.deletedAt,
    );
    if (!a) continue;
    const saved = await readTransaction(async (tx) => ({
      source: await readRecord<string>(tx, "application_sources", id),
      resume: a.resumeId
        ? (
            await tx.query(
              "SELECT filename,extracted_text FROM resumes WHERE id=$1",
              [a.resumeId],
            )
          )[0]
        : undefined,
    }));
    const text = saved.resume
      ? unseal<string>(
          String(saved.resume.extracted_text),
          config().encryptionKey,
        )
      : "";
    let source: EmailSource = saved.source
      ? unseal(saved.source, config().encryptionKey)
      : {
          subject: a.originalSubject || "",
          body: "",
          from: a.applicant.name + " <" + a.applicant.email + ">",
          filename: String(saved.resume?.filename || ""),
        };
    if (!saved.source && a.gmailMessageId) {
      token ||= await accessToken(await official());
      const message = await gmail<{
        payload: {
          headers: { name: string; value: string }[];
          mimeType?: string;
          body?: { data?: string };
          parts?: unknown[];
        };
      }>(token, `messages/${encodeURIComponent(a.gmailMessageId)}?format=full`);
      const header = (name: string) =>
        message.payload.headers.find((h) => h.name.toLowerCase() === name)
          ?.value || "";
      source = {
        subject: header("subject"),
        body: messageBody(message.payload),
        from: header("from"),
        filename: source.filename,
      };
    }
    prepared.push({
      id,
      text,
      source,
      evidence: intakeEvidence({ ...source, resume: text }),
      before: a,
    });
  }
  return transaction(async (tx) => {
    const state = await getState(tx);
    let updated = 0;
    for (const p of prepared) {
      const a = state.applications.find(
        (v) => v.id === p.id && !v.isDemo && !v.deletedAt,
      );
      if (!a || JSON.stringify(a) !== JSON.stringify(p.before)) continue;
      if (a.extraction?.warnings.length)
        await recordIssue(
          "documents.extraction",
          { entityId: a.id, user: user.email },
          tx,
        );
      const previous = {
        applicant: structuredClone(a.applicant),
        information: structuredClone(a.information),
        name: a.applicant.name,
        residence: a.applicant.location,
        position: a.position,
        location: a.location,
        screening: a.screening,
      };
      const info = evidenceInformation(p.evidence);
      a.information ||= { fields: {}, conflicts: [] };
      for (const key of [
        "name",
        "phone",
        "education",
        "availability",
        "experienceDetails",
        "residence",
        "position",
        "location",
      ] as const) {
        if (a.information.fields[key]?.verifiedBy) continue;
        const value = p.evidence[key];
        if (!value || /requires review|not verified/i.test(value)) continue;
        if (key === "position" || key === "location") a[key] = value;
        else a.applicant[key === "residence" ? "location" : key] = value;
        if (info.fields[key]) a.information.fields[key] = info.fields[key];
      }
      a.information.conflicts = info.conflicts;
      a.originalSubject ||= p.source.subject.slice(0, 200);
      const need = state.hiringNeeds.find((n) => n.id === a.hiringNeedId);
      const rules = need?.criteria || [];
      if (a.screening.method !== "hr" && !a.screening.completedAt) {
        const criteria = screenResumeAgainstCriteria(
          p.text,
          rules,
          !a.extraction?.warnings.length,
        );
        a.screening = {
          criteria,
          outcome: "Requires Review",
          completedAt: "",
          method: "rules",
          insight: buildInsight(
            criteria,
            a.position,
            a.location,
            !!p.text.trim(),
          ),
        };
      }
      await putRecord(
        tx,
        "application_sources",
        a.id,
        seal(p.source, config().encryptionKey),
      );
      await putRecord(tx, "intake_evidence", a.id, {
        evidence: p.evidence.evidence,
        warnings: p.evidence.warnings,
        at: new Date().toISOString(),
      });
      const next = {
        applicant: structuredClone(a.applicant),
        information: structuredClone(a.information),
        name: a.applicant.name,
        residence: a.applicant.location,
        position: a.position,
        location: a.location,
        screening: a.screening,
      };
      await queueExtraction(tx, a, user.email);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        updated++;
        await audit(tx, user.email, "application.evidence_reprocessed", a.id, {
          previous,
          next,
          note: "Reprocessed submitted evidence. HR decisions preserved.",
        });
        a.timeline.push({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          user: user.email,
          action: "Submitted application evidence reprocessed",
          applicationId: a.id,
          metadata: {
            note: "Position/location extracted independently of hiring needs. No stage or decision changed.",
          },
        });
      }
    }
    if (prepared.length) await saveState(tx, state, { sync: false });
    return { updated, checked: prepared.length };
  });
}
