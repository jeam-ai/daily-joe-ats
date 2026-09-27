import { formalName } from "./names";

const tidy = (value: string) => value.trim().replace(/[ \t]+/g, " ");
const acronyms = new Set([
  "NBI",
  "SSS",
  "PUP",
  "LGU",
  "HR",
  "IT",
  "MBA",
  "BS",
  "BA",
  "NCII",
  "TESDA",
]);
const titleConnectors = new Set(["and", "at", "de", "for", "in", "of", "the"]);

function formalTitle(value: string) {
  return value.replace(/\p{L}[\p{L}'’-]*/gu, (word, offset) => {
    if (acronyms.has(word.toUpperCase())) return word.toUpperCase();
    if (offset > 0 && titleConnectors.has(word.toLowerCase()))
      return word.toLowerCase();
    return word
      .toLowerCase()
      .replace(/^\p{L}/u, (letter) => letter.toUpperCase());
  });
}

export function formalFact(field: string, value: string): string {
  const text = tidy(value).replace(
    /\b(\d{4})\s*[-–—]\s*(\d{4}|present)\b/gi,
    (_, start: string, end: string) =>
      `${start}–${end.toLowerCase() === "present" ? "Present" : end}`,
  );
  if (!text) return text;
  if (field === "name") return formalName(text);
  if (
    ["education", "position", "location", "skills", "certifications"].includes(
      field,
    ) &&
    text.split(/\s+/).length <= 14
  )
    return formalTitle(text);
  const letters = text.replace(/[^\p{L}]/gu, "");
  const uniform =
    letters === letters.toLowerCase() || letters === letters.toUpperCase();
  if (
    field === "experienceDetails" ||
    field === "availability" ||
    (field === "education" && text.split(/\s+/).length > 8)
  ) {
    const sentence =
      uniform && letters === letters.toUpperCase() ? text.toLowerCase() : text;
    return sentence.replace(/\p{L}/u, (letter) => letter.toUpperCase());
  }
  if (!uniform) return text;
  return formalTitle(text);
}
