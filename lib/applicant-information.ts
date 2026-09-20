import type { Application } from "@/types";
import type { intakeEvidence } from "./intake-evidence";
export const missingInformation = (value?: string) =>
  !value?.trim() || /requires review|not verified|^unknown$/i.test(value);
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
