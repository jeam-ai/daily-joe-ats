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

export function formalFact(field: string, value: string): string {
  const text = tidy(value);
  if (!text) return text;
  if (field === "name") return formalName(text);
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
  return text.replace(/\p{L}[\p{L}'’-]*/gu, (word) => {
    if (acronyms.has(word.toUpperCase())) return word.toUpperCase();
    return word
      .toLowerCase()
      .replace(/^\p{L}/u, (letter) => letter.toUpperCase());
  });
}
