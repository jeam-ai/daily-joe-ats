import type { HiringNeed } from "@/types";
const normalized = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function matchHiringNeed(subject: string, needs: HiringNeed[]) {
  const text = ` ${normalized(subject)} `;
  const matches = needs.filter(
    (n) =>
      !n.isDemo &&
      n.status === "Open" &&
      [n.position, n.location].every(
        (value) => normalized(value) && text.includes(` ${normalized(value)} `),
      ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export function senderName(from: string) {
  const display = from.includes("<")
    ? from.split("<")[0].trim().replace(/^"|"$/g, "")
    : "";
  return display && display.length <= 200 && !display.includes("@")
    ? display
    : "Name requires review";
}
