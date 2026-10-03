import "server-only";
import { createHash } from "node:crypto";
import type { Application, User } from "@/types";
import {
  applicantFieldProtected,
  evidenceInformation,
  missingInformation,
} from "@/lib/applicant-information";
import { intakeEvidence } from "@/lib/intake-evidence";
import { formalFact } from "@/lib/formal-facts";
import { canManage } from "@/lib/data-policy";
import { seal, unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import {
  readTransaction,
  transaction,
  readRecord,
  putRecord,
} from "./database";
import { getState, saveState, audit } from "./repository";

const fields = [
  "name",
  "email",
  "phone",
  "residence",
  "education",
  "availability",
  "experienceDetails",
  "skills",
  "certifications",
  "position",
  "location",
] as const;
type Field = (typeof fields)[number];
export type ExtractionChange = {
  applicationId: string;
  applicantName: string;
  field: Field;
  previous: string;
  proposed: string;
  protected: boolean;
  provenance: NonNullable<Application["information"]>["fields"][string];
};
type Preview = {
  actor: string;
  expiresAt: number;
  versions: Record<string, string>;
  changes: ExtractionChange[];
};
const fingerprint = (a: Application) =>
  createHash("sha256").update(JSON.stringify(a)).digest("hex");
function value(a: Application, key: Field) {
  return String(
    key === "position" || key === "location"
      ? a[key]
      : a.applicant[key === "residence" ? "location" : key] || "",
  );
}

export async function previewApplicantReprocessing(ids: string[], user: User) {
  if (!canManage(user))
    throw new SafeError("Recruitment manager access required.", 403);
  if (!ids.length || ids.length > 10000 || new Set(ids).size !== ids.length)
    throw new SafeError("Select distinct applicants for reprocessing.");
  const prepared = await readTransaction(async (tx) => {
    const state = await getState(tx),
      changes: ExtractionChange[] = [],
      versions: Record<string, string> = {},
      unavailable: string[] = [];
    for (const id of ids) {
      const a = state.applications.find(
        (v) => v.id === id && !v.deletedAt && !v.isDemo,
      );
      if (!a)
        throw new SafeError(
          "An applicant is unavailable. Refresh the selection.",
          409,
        );
      const saved = await readRecord<string>(tx, "application_sources", id);
      const resume = a.resumeId
        ? (
            await tx.query(
              "SELECT filename,extracted_text FROM resumes WHERE id=$1",
              [a.resumeId],
            )
          )[0]
        : undefined;
      const source = saved
        ? unseal<{ subject: string; body: string; from: string }>(
            saved,
            config().encryptionKey,
          )
        : {
            subject: a.originalSubject || "",
            body: "",
            from: a.applicant.email,
          };
      const text = resume?.extracted_text
        ? unseal<string>(String(resume.extracted_text), config().encryptionKey)
        : "";
      if (!saved && !text) {
        unavailable.push(id);
        continue;
      }
      const evidence = intakeEvidence({
        ...source,
        filename: String(resume?.filename || ""),
        resume: text,
        positions: state.qualifications.map((v) => v.position),
        locations: state.locations?.map((v) => v.name),
        locationDetails: state.locations,
      });
      const info = evidenceInformation(evidence);
      versions[id] = fingerprint(a);
      for (const key of fields) {
        const proposed = formalFact(key, evidence[key] || "");
        const provenance = info.fields[key];
        if (
          !provenance ||
          missingInformation(proposed) ||
          proposed === value(a, key)
        )
          continue;
        changes.push({
          applicationId: id,
          applicantName: a.applicant.name,
          field: key,
          previous: value(a, key),
          proposed,
          protected: applicantFieldProtected(a, key),
          provenance,
        });
      }
    }
    return { changes, versions, unavailable };
  });
  const id = crypto.randomUUID();
  await transaction((tx) =>
    putRecord(
      tx,
      "applicant_reprocessing",
      id,
      seal(
        {
          actor: user.email,
          expiresAt: Date.now() + 30 * 60000,
          versions: prepared.versions,
          changes: prepared.changes,
        } satisfies Preview,
        config().encryptionKey,
      ),
    ),
  );
  return {
    id,
    changes: prepared.changes,
    unavailable: prepared.unavailable,
    checked: ids.length,
  };
}

export async function applyApplicantReprocessing(
  id: string,
  selected: string[],
  overwriteProtected: boolean,
  user: User,
) {
  if (!canManage(user))
    throw new SafeError("Recruitment manager access required.", 403);
  if (!selected.length || new Set(selected).size !== selected.length)
    throw new SafeError("Choose distinct previewed corrections.");
  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(
      tx,
      "applicant_reprocessing",
      id,
    );
    if (!encrypted)
      throw new SafeError(
        "Preview expired or already applied. Preview again.",
        409,
      );
    const preview = unseal<Preview>(encrypted, config().encryptionKey);
    if (preview.actor !== user.email || preview.expiresAt < Date.now())
      throw new SafeError("Preview expired. Preview again.", 409);
    const changes = preview.changes.filter((c) =>
      selected.includes(`${c.applicationId}:${c.field}`),
    );
    if (changes.length !== selected.length)
      throw new SafeError("Choose corrections from this preview.");
    const state = await getState(tx),
      ids = [...new Set(changes.map((c) => c.applicationId))];
    for (const applicationId of ids) {
      const a = state.applications.find(
        (v) => v.id === applicationId && !v.deletedAt && !v.isDemo,
      );
      if (!a || fingerprint(a) !== preview.versions[applicationId])
        throw new SafeError(
          "An applicant changed after preview. Preview again to protect the latest edits.",
          409,
        );
      const previous = structuredClone(a);
      for (const change of changes.filter(
        (c) => c.applicationId === applicationId,
      )) {
        if (
          change.field === "email" &&
          state.applications.some(
            (other) =>
              other.id !== a.id &&
              other.applicant.email.toLowerCase() ===
                change.proposed.toLowerCase(),
          )
        )
          throw new SafeError(
            "This email is already used by another applicant. Review the source before applying this correction.",
            409,
          );
        if (
          (change.protected || applicantFieldProtected(a, change.field)) &&
          !overwriteProtected
        )
          throw new SafeError(
            "Explicitly enable overwriting protected fields to apply that correction.",
            409,
          );
        if (change.field === "position" || change.field === "location")
          a[change.field] = change.proposed;
        else
          a.applicant[
            change.field === "residence" ? "location" : change.field
          ] = change.proposed;
        a.information ||= { fields: {}, conflicts: [] };
        a.information.fields[change.field] = {
          ...change.provenance,
          verifiedBy: user.email,
        };
      }
      const now = new Date().toISOString();
      a.lastActivity = now;
      a.timeline.push({
        id: crypto.randomUUID(),
        timestamp: now,
        user: user.email,
        action: "Extraction corrections applied after preview",
        applicationId: a.id,
        metadata: {
          fields: changes
            .filter((c) => c.applicationId === a.id)
            .map((c) => c.field)
            .join(", "),
          overwriteProtected: String(overwriteProtected),
        },
      });
      await audit(tx, user.email, "application.extraction_corrected", a.id, {
        previous,
        next: a,
        previewId: id,
        overwriteProtected,
      });
    }
    await saveState(tx, state, { sync: false });
    await tx.query(
      "DELETE FROM records WHERE collection='applicant_reprocessing' AND id=$1",
      [id],
    );
    return { updated: ids.length, fields: changes.length };
  });
}
