import type { Application } from "@/types";
export function aiEligibility(a: Application): string[] {
  const reasons: string[] = [];
  if (a.extraction?.confidence !== undefined && a.extraction.confidence < 80)
    reasons.push("Low OCR confidence");
  if (a.extraction?.warnings.length)
    reasons.push("Incomplete document extraction");
  if (
    !a.applicant.email ||
    !a.applicant.name ||
    /unknown|review|not verified/i.test(
      a.applicant.name + " " + a.position + " " + a.location,
    )
  )
    reasons.push("Applicant information needs verification");
  if (a.screening.criteria.some((c) => c.result === "Unclear"))
    reasons.push("Qualification evidence is unclear");
  if (a.extraction?.warnings.some((w) => /conflict/i.test(w)))
    reasons.push("Conflicting extracted information");
  return reasons;
}
