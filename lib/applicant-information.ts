import type { Application } from "@/types";
import type { intakeEvidence } from "./intake-evidence";
import { formalFact } from "./formal-facts";
const genericProfileName = (value?: string) =>
  /\b(?:place\s+of\s+birth|date\s+of\s+birth|civil\s+status|marital\s+status|nationality|gender|\bsingle\b)\b/i.test(
    value || "",
  );
export const missingInformation = (value?: string) =>
  !value?.trim() ||
  /requires review|needs verification|not verified|not clearly stated|not confirmed from submitted information|^unknown$/i.test(
    value,
  );
export function applicantFieldProtected(
  application: Application,
  field: string,
) {
  const provenance = application.information?.fields[field];
  const current =
    field === "position" || field === "location" || field === "assignedBranch"
      ? application[field]
      : (application.applicant as unknown as Record<string, unknown>)[
          field === "residence" ? "location" : field
        ];
  return (
    !!provenance?.verifiedBy ||
    /^(?:HR|Manual)/i.test(provenance?.source || "") ||
    (!!application.editedBy &&
      !provenance &&
      !missingInformation(String(current || "")))
  );
}
export function applicantDisplayName(application: Application) {
  const name = application.applicant.name;
  if (
    !application.information?.fields.name?.verifiedBy &&
    (genericProfileName(name) ||
      /\b(?:applying|writing|interest|job|position|post|opportunity)\b/i.test(
        name,
      ))
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
        (() => {
          const source =
            key === "name"
              ? evidence.startsWith("Resume:")
                ? "Resume"
                : evidence.startsWith("Attachment filename:")
                  ? "Attachment filename"
                  : evidence.startsWith("Email body:")
                    ? "Email body"
                    : evidence.startsWith("Email subject:")
                      ? "Email subject"
                      : "Gmail display name"
              : e.sources?.[key] || "Submitted evidence";
          const uncertain =
            source === "Residence match" ||
            source === "Email subject" ||
            source === "Attachment filename" ||
            source === "Gmail display name" ||
            (key === "name" && (e.nameUncertain ?? false));
          return {
            source,
            evidence,
            confidence: uncertain
              ? ("Uncertain" as const)
              : ("Confident" as const),
          };
        })(),
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
    ["Resume", "Email body", "Attachment filename"].includes(
      incoming.fields.name?.source || "",
    ) &&
    !applicantFieldProtected(application, "name") &&
    evidence.name &&
    !missingInformation(evidence.name) &&
    (["Resume", "Email body"].includes(incoming.fields.name?.source || "") ||
      missingInformation(application.applicant.name) ||
      genericProfileName(application.applicant.name) ||
      /\b(?:applying|writing|interest|job|position|post|opportunity)\b/i.test(
        application.applicant.name,
      ))
  ) {
    application.applicant.name = formalFact("name", evidence.name);
    fields.name = incoming.fields.name;
  }
  for (const [key, value] of [
    ["email", evidence.email],
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
    if (
      !value ||
      missingInformation(value) ||
      applicantFieldProtected(application, key)
    )
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
    const subjectPositionIncludesBranch =
      key === "position" &&
      evidence.location === "General Trias" &&
      !!current &&
      current
        .replace(
          /(?:\s+(?:at|in|for|branch)\s+|\s*[-—–|,]\s*|\s+)(?:general\s+trias|gen\.?\s*tri(?:as)?)\s*$/i,
          "",
        )
        .trim()
        .toLocaleLowerCase() === value.toLocaleLowerCase() &&
      current.trim().toLocaleLowerCase() !== value.toLocaleLowerCase();
    const longerResumeAddress =
      key === "residence" &&
      incoming.fields.residence?.source === "Resume" &&
      fields.residence?.source === "Resume" &&
      !!current &&
      value
        .toLocaleLowerCase()
        .startsWith(current.trim().toLocaleLowerCase()) &&
      value.length > current.trim().length + 4;
    const correctedEducation =
      key === "education" &&
      fields.education?.source === "Resume" &&
      incoming.fields.education?.source === "Resume" &&
      !!current &&
      ((/\b(?:certifications?|certificates?|trainings?|tesda|nc\s*i{1,3})\b/i.test(
        current,
      ) &&
        !/\b(?:certifications?|certificates?|trainings?|tesda|nc\s*i{1,3})\b/i.test(
          value,
        )) ||
        (!/\b(?:19|20)\d{2}\b/.test(current) &&
          /\b(?:19|20)\d{2}\b/.test(value) &&
          /\b(?:school|college|university|lyceum|polytechnic|institute)\b/i.test(
            value,
          )) ||
        (/\b(?:service\s+crew|barista|cashier|waiter|waitress|ojt|work(?:ed|ing)?|experience|employment)\b/i.test(
          current,
        ) &&
          !/\b(?:service\s+crew|barista|cashier|waiter|waitress|ojt|work(?:ed|ing)?|experience|employment)\b/i.test(
            value,
          )));
    const correctedSkills =
      key === "skills" &&
      fields.skills?.source === "Resume" &&
      incoming.fields.skills?.source === "Resume" &&
      /\b(?:school|academic\s+track|sponsored\s+by|trainings?\s+attended|career\s+guidance|\b(?:19|20)\d{2}\b)\b/i.test(
        current || "",
      ) &&
      !/\b(?:school|academic\s+track|sponsored\s+by)\b/i.test(value);
    const correctedCertification =
      key === "certifications" &&
      fields.certifications?.source === "Resume" &&
      incoming.fields.certifications?.source === "Resume" &&
      /^trainings?\s+attended\.?$/i.test(current || "") &&
      !/^trainings?\s+attended\.?$/i.test(value);
    const correctedResidence =
      key === "residence" &&
      incoming.fields.residence?.source === "Resume" &&
      fields.residence?.source === "Resume" &&
      !!current &&
      /(?:processed\s+(?:cash|card|digital)|customer\s+service|experience|objective|profile)/i.test(
        current,
      ) &&
      /\b(?:blk\.?|block|lot|house|unit|purok|zone|sitio|brgy\.?|barangay|subd\.?|subdivision|street|st\.?|road|rd\.?|city|province)\b/i.test(
        value,
      );
    if (
      !missingInformation(current) &&
      !subjectPositionIncludesName &&
      !subjectPositionIncludesBranch &&
      !longerResumeAddress &&
      !correctedEducation &&
      !correctedResidence &&
      !correctedSkills &&
      !correctedCertification
    )
      continue;
    if (key === "position" || key === "location")
      application[key] = formalFact(key, value);
    else if (key === "residence")
      application.applicant.location = formalFact(key, value);
    else application.applicant[key] = formalFact(key, value);
    if (incoming.fields[key]) fields[key] = incoming.fields[key];
  }
  if (
    evidence.residenceLocation &&
    (!application.assignedBranch ||
      /^unassigned$/i.test(application.assignedBranch)) &&
    !applicantFieldProtected(application, "assignedBranch")
  ) {
    application.assignedBranch = evidence.residenceLocation;
    if (incoming.fields.assignedBranch)
      fields.assignedBranch = incoming.fields.assignedBranch;
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
  if (missingInformation(a.applicant.education))
    reasons.push("Education needs extraction");
  if (missingInformation(a.applicant.availability))
    reasons.push("Availability needs extraction");
  if (missingInformation(a.applicant.experienceDetails))
    reasons.push("Experience needs extraction");
  if (missingInformation(a.applicant.skills))
    reasons.push("Skills need extraction");
  if (missingInformation(a.applicant.certifications))
    reasons.push("Certifications need extraction");
  // OCR warnings are review signals, not a reason to spend limited AI quota.
  // Gemini is reserved for actual gaps remaining after deterministic resume,
  // email-body, and subject parsing has run.
  if (a.information?.conflicts.length)
    reasons.push("Submitted sources conflict");
  return reasons;
}
