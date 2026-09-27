import type { QualificationRule, ScreeningResult } from "@/types";

type QualificationTemplateLike = {
  position: string;
  rules?: QualificationRule[];
};

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Hiring-need rules take priority. If that need was created without its own
 * rules, use the matching reusable template instead of silently screening an
 * applicant against an empty checklist. Position matching is deliberately
 * punctuation/branch tolerant (for example, "Barista - SM San Pedro").
 */
export function qualificationRulesForPosition(
  position: string,
  hiringNeedCriteria?: QualificationRule[],
  templates: QualificationTemplateLike[] = [],
) {
  if (hiringNeedCriteria?.length) return hiringNeedCriteria;
  const applied = normalize(position);
  if (!applied) return [];
  const match = templates
    .map((template) => {
      const candidate = normalize(template.position);
      const score =
        candidate === applied
          ? 3
          : candidate.length > 2 &&
              (applied.includes(candidate) || candidate.includes(applied))
            ? 2
            : 0;
      return { template, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.template.position.length - a.template.position.length,
    )[0];
  return match?.template.rules || [];
}

const durationWords: Record<string, number> = { one: 1, two: 2, three: 3 };

function requiredYears(label: string) {
  const duration = label
    .toLowerCase()
    .match(
      /(?:minimum of |at least )?(\d+(?:\.\d+)?|one|two|three)\s*\+?\s*years?/,
    );
  return duration ? durationWords[duration[1]] || Number(duration[1]) || 0 : 0;
}

function explicitDuration(value: string) {
  const stated = value.match(
    /(\d+(?:\.\d+)?|one|two|three)\s*(years?|months?)/i,
  );
  if (stated) {
    const amount = durationWords[stated[1].toLowerCase()] || Number(stated[1]);
    return amount * (/^month/i.test(stated[2]) ? 1 / 12 : 1);
  }
  let longest = 0;
  for (const period of value.matchAll(
    /\b(19\d{2}|20\d{2})\s*(?:-|–|—|to)\s*(present|19\d{2}|20\d{2})\b/gi,
  )) {
    const start = Number(period[1]);
    const end = /^present$/i.test(period[2])
      ? new Date().getFullYear()
      : Number(period[2]);
    if (end >= start && end - start > longest) longest = end - start;
  }
  return longest;
}

function hasNegatedOrAspirationalContext(value: string) {
  return /\b(?:no|not|without|lack\w*|never|seeking|objective|interested|aspiring)\b/i.test(
    value,
  );
}

function equivalentMatch(text: string, label: string) {
  const requirement = normalize(label);
  const years = requiredYears(label);
  const lines = text.split(/\n+/).filter(Boolean);
  const semanticPatterns: Array<[RegExp, RegExp]> = [
    [
      /\bbarista\b|\bcoffee\s*(?:shop|preparation|making)\b|\b(?:cafe|café)\b|\bespresso\b/i,
      /barista|coffee|beverage/i,
    ],
    [
      /\bcustomer[ -]service\b|\bcustomer[ -]facing\b|\bassisted customers\b|\bserved customers\b|\bhandled customer (?:orders|inquiries)\b|\bcustomer[- ]oriented\b|\bservice crew\b|\bretail (?:customer service|sales)\b|\bhospitality\b/i,
      /customer service|customer.*experience/i,
    ],
    [
      /\bcash\s*handling\b|\bcashier\b|\bprocessed cash\b|\bcash transactions?\b|\bpoint of sale\b|\bpos systems?\b|\bdigital transactions?\b/i,
      /cash handling|cashier|pos|transaction/i,
    ],
    [
      /\bhigh\s+school\s+(?:graduate|graduated)\b|\bsenior\s+high(?:\s+school)?\b|\bsecondary\s+school\b/i,
      /high school.*(?:graduate|equivalent)|(?:graduate|equivalent).*high school/i,
    ],
    [
      /\bbachelor(?:'s)?\b|\bcollege\b|\buniversity\b|\btertiary\b/i,
      /bachelor|college(?: degree| graduate)?|tertiary/i,
    ],
    [
      /\b(?:verbal|written|interpersonal) communication\b|\bcommunicat(?:ion|e)\b/i,
      /communication/i,
    ],
    [/\b(?:flexible|adaptable|adaptability)\b/i, /adaptab|flexib/i],
    [
      /\b(?:teamwork|team player|collaborat(?:e|ive|ion))\b/i,
      /teamwork|team player|collaborat/i,
    ],
    [
      /\b(?:shift(?:ing)? schedule|rotating shift|weekend(?:s)?|flexible hours?)\b/i,
      /shift|schedule availability|available.*(?:weekend|hours)/i,
    ],
    [
      /\b(?:food service|restaurant|kitchen|food preparation)\b/i,
      /food service|restaurant|food preparation/i,
    ],
    [
      /\b(?:retail sales|sales associate|sales representative|sales experience)\b/i,
      /sales/i,
    ],
    [
      /\b(?:certificate|certification|tesda|training)\b/i,
      /certif|tesda|training/i,
    ],
  ];
  const semantic = semanticPatterns.find(([, expected]) =>
    expected.test(requirement),
  );
  if (!semantic) return null;
  const [pattern] = semantic;
  for (let index = 0; index < lines.length; index++) {
    const nearby = lines.slice(Math.max(0, index - 1), index + 3).join(" ");
    if (!pattern.test(nearby) || hasNegatedOrAspirationalContext(nearby))
      continue;
    if (years && explicitDuration(nearby) < years) continue;
    const line = lines[index];
    const offset = text.indexOf(line);
    return Object.assign([nearby], {
      index: Math.max(0, offset),
      input: text,
    }) as RegExpExecArray;
  }
  return null;
}

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
      .join("(?:\\s+|[-/.,]+)");
    let match =
      expression && reliable ? new RegExp(expression, "i").exec(text) : null;
    // Exact wording is preferred. Equivalent evidence is accepted only when it
    // states the same skill; duration rules still require a stated duration or
    // a date range adjacent to the relevant role.
    if (!match && reliable) {
      match = equivalentMatch(text, criterion.label);
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
          ? `${negated ? "Possible negation; HR verification required" : expression && new RegExp(expression, "i").test(match[0]) ? "Direct resume mention detected" : "Equivalent resume evidence detected"}: “${context}”. Verify in the original document.`
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
