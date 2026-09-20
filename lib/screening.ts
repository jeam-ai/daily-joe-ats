import type { QualificationRule, ScreeningResult } from "@/types";
export function screenResumeAgainstCriteria(
  text: string,
  criteria: QualificationRule[],
  reliable = true,
) {
  return criteria.map((criterion) => {
    const expression = criterion.label
      .trim()
      .split(/\s+/)
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    let match =
      expression && reliable ? new RegExp(expression, "i").exec(text) : null;
    // Conservative aliases accept equivalent wording only when evidence states the
    // same skill. Duration requirements still require an explicit duration.
    if (!match && reliable) {
      const required = criterion.label.toLowerCase();
      const duration = required.match(
        /(?:minimum of |at least )?(\d+(?:\.\d+)?|one|two|three)\s*\+?\s*years?/,
      );
      const years = duration
        ? { one: 1, two: 2, three: 3 }[duration[1] as "one"] ||
          Number(duration[1])
        : 0;
      if (/barista/.test(required)) {
        const lines = text.split(/\n/);
        for (const line of lines) {
          if (
            !/\b(?:barista|beverage preparation|coffee preparation)\b/i.test(
              line,
            ) ||
            /\b(?:no|not|without|seeking|objective|interested|aspiring)\b/i.test(
              line,
            )
          )
            continue;
          const stated = line.match(
            /(\d+(?:\.\d+)?|one|two|three)\s*(years?|months?)/i,
          );
          const amount = stated
            ? ({ one: 1, two: 2, three: 3 }[stated[1].toLowerCase() as "one"] ||
                Number(stated[1])) * (/^month/i.test(stated[2]) ? 1 / 12 : 1)
            : 0;
          if (years && amount < years) continue;
          const offset = text.indexOf(line);
          match = Object.assign([line], {
            index: offset,
            input: text,
          }) as RegExpExecArray;
          break;
        }
      } else if (!duration && /customer[ -]service/.test(required))
        match =
          /\b(?:customer[ -]facing (?:work|role|responsibilities)|assisted customers|served customers|handled customer (?:orders|inquiries))\b/i.exec(
            text,
          );
    }
    const context = match
      ? text
          .slice(
            Math.max(0, match.index - 100),
            match.index + match[0].length + 100,
          )
          .replace(/\s+/g, " ")
      : "";
    const negated =
      match &&
      /\b(no|not|without|lack\w*|never)\b[^.!?\n]{0,50}$/i.test(
        text.slice(Math.max(0, match.index - 70), match.index),
      );
    return {
      id: criterion.id,
      requirement: criterion.label,
      result: !text.trim()
        ? ("Not Assessed" as const)
        : match && !negated
          ? ("Met" as const)
          : !match && criterion.absenceFails && reliable && text.trim()
            ? ("Not Met" as const)
            : ("Unclear" as const),
      evidence: !text.trim()
        ? "No readable submitted content is available. Review the original document before assessment."
        : match
          ? `${negated ? "Possible negation; HR verification required" : "Direct resume mention detected"}: “${context}”. Verify in the original document.`
          : criterion.absenceFails && reliable && text.trim()
            ? "No evidence found. This configured HR rule explicitly treats missing evidence as not met; HR must verify extraction completeness."
            : "No direct text match was detected. Missing OCR or resume text is not a failed qualification; HR must review the original resume.",
    };
  });
}
export function buildInsight(
  criteria: ScreeningResult["criteria"],
  position: string,
  location: string,
  readable = true,
) {
  if (!readable)
    return `Unable to confidently extract information for the ${position} hiring need in ${location}. Review the original document and verify employment dates, education, and availability before assessing qualifications.`;
  if (!criteria.length)
    return `No qualifications are configured for ${position} in ${location}. Configure this hiring need before assessing the resume.`;
  const met = criteria
    .filter((c) => c.result === "Met")
    .map((c) => c.requirement);
  const unclear = criteria
    .filter((c) => c.result === "Unclear" || c.result === "Not Assessed")
    .map((c) => c.requirement);
  const failed = criteria
    .filter((c) => c.result === "Not Met")
    .map((c) => c.requirement);
  return `This assessment uses the configured qualifications for ${position} in ${location}. ${met.length ? `Evidence was identified for ${met.join("; ")}. ` : "No qualifications have verified supporting evidence yet. "}${failed.length ? `The evidence does not establish: ${failed.join("; ")}. ` : ""}${unclear.length ? `The resume does not provide enough reliable evidence for ${unclear.join("; ")}; confirm these during HR review. ` : ""}These observations support HR review and do not decide the applicant's outcome.`;
}
