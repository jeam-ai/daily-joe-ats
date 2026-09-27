import type { Application } from "@/types";
import type { intakeEvidence } from "./intake-evidence";
import { formalFact } from "./formal-facts";
export const missingInformation = (value?: string) =>
  !value?.trim() ||
  /requires review|needs verification|not verified|not clearly stated|not confirmed from submitted information|^unknown$/i.test(
    value,
  );
export function applicantDisplayName(application: Application) {
  const name = application.applicant.name;
  if (
    !application.information?.fields.name?.verifiedBy &&
    /\b(?:applying|writing|interest|job|position|post|opportunity)\b/i.test(
      name,
    )
  )
    return "Name needs verification";
  return formalFact("name", name);
}
export function evidenceInformation(
  e: ReturnType<typeof intakeEvidence>,
): NonNullable<Application["information"]> {
  return {
    fields: Object.fromEntries(
      Object.entries(e.evidence).map(([key, evidence]) => [
        key,
        {
          source:
            key === "name"
              ? evidence.startsWith("Resume:")
                ? "Resume"
                : evidence.startsWith("Attachment filename:")
                  ? "Attachment filename"
                  : evidence.startsWith("Email body:")
                    ? "Email body"
                    : "Gmail display name"
              : e.sources?.[key] || "Submitted evidence",
          evidence,
          confidence:
            key === "name" &&
            (e.nameUncertain ?? evidence === "Gmail sender display name")
              ? ("Uncertain" as const)
              : ("Confident" as const),
        },
      ]),
    ),
    conflicts: e.warnings,
  };
}
export function applyRecoveredResumeEvidence(
  application: Application,
  evidence: ReturnType<typeof intakeEvidence>,
) {
  const incoming = evidenceInformation(evidence);
  application.information ||= { fields: {}, conflicts: [] };
  const fields = application.information.fields;
  // A resume identity is stronger than an unverified email sentence or sender
  // display name. HR-verified names always take precedence.
  if (
    ["Resume", "Attachment filename"].includes(
      incoming.fields.name?.source || "",
    ) &&
    !fields.name?.verifiedBy &&
    evidence.name &&
    !missingInformation(evidence.name) &&
    (incoming.fields.name?.source === "Resume" ||
      missingInformation(application.applicant.name) ||
      /\b(?:applying|writing|interest|job|position|post|opportunity)\b/i.test(
        application.applicant.name,
      ))
  ) {
    application.applicant.name = formalFact("name", evidence.name);
    fields.name = incoming.fields.name;
  }
  for (const [key, value] of [
    ["phone", evidence.phone],
    ["education", evidence.education],
    ["availability", evidence.availability],
    ["experienceDetails", evidence.experienceDetails],
    ["skills", evidence.skills],
    ["certifications", evidence.certifications],
    ["residence", evidence.residence],
    ["position", evidence.position],
    ["location", evidence.location],
  ] as const) {
    if (!value || missingInformation(value) || fields[key]?.verifiedBy)
      continue;
    const current =
      key === "position" || key === "location"
        ? application[key]
        : key === "residence"
          ? application.applicant.location
          : application.applicant[key];
    const subjectPositionIncludesName =
      key === "position" &&
      !!evidence.name &&
      current?.trim().toLocaleLowerCase() ===
        `${value} - ${evidence.name}`.toLocaleLowerCase();
    const longerResumeAddress =
      key === "residence" &&
      incoming.fields.residence?.source === "Resume" &&
      fields.residence?.source === "Resume" &&
      !!current &&
      value
        .toLocaleLowerCase()
        .startsWith(current.trim().toLocaleLowerCase()) &&
      value.length > current.trim().length + 4;
    if (
      !missingInformation(current) &&
      !subjectPositionIncludesName &&
      !longerResumeAddress
    )
      continue;
    if (key === "position" || key === "location")
      application[key] = formalFact(key, value);
    else if (key === "residence")
      application.applicant.location = formalFact(key, value);
    else application.applicant[key] = formalFact(key, value);
    if (incoming.fields[key]) fields[key] = incoming.fields[key];
  }
  application.information.conflicts = [
    ...new Set([
      ...application.information.conflicts.filter(
        (conflict) =>
          !/information conflict detected: resume identifies .*email display name/i.test(
            conflict,
          ) || incoming.conflicts.some((fresh) => fresh === conflict),
      ),
      ...incoming.conflicts,
    ]),
  ].slice(0, 12);
}
export function extractionReasons(a: Application) {
  if (a.isDemo || a.deletedAt) return [];
  const reasons: string[] = [];
  if (
    missingInformation(a.applicant.name) ||
    a.information?.fields.name?.confidence === "Uncertain"
  )
    reasons.push("Applicant identity needs verification");
  if (missingInformation(a.position))
    reasons.push("Applied position is unclear");
  if (missingInformation(a.location))
    reasons.push("Preferred work location is unclear");
  if (missingInformation(a.applicant.location))
    reasons.push("Residence is missing");
  if (missingInformation(a.applicant.phone))
    reasons.push("Phone number is missing");
  if (
    !a.applicant.email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.applicant.email)
  )
    reasons.push("Email needs verification");
  if (
    a.extraction?.method === "ocr" ||
    a.extraction?.method === "mixed" ||
    a.extraction?.warnings.length ||
    (a.extraction?.confidence ?? 100) <= 80
  )
    reasons.push("Document extraction is incomplete or uncertain");
  if (a.information?.conflicts.length)
    reasons.push("Submitted sources conflict");
  return reasons;
}
