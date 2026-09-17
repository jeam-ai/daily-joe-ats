import type { AppState } from "@/types";
type Preferences = AppState["preferences"];
export function formatDate(
  value: string | number | Date,
  preferences?: Preferences,
  time = false,
) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "Not set";
  return d.toLocaleString(preferences?.dateFormat || "en-PH", {
    timeZone: preferences?.timezone || "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(time ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
  });
}
export function monthKey(
  value: string | number | Date,
  timezone = "Asia/Manila",
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(value));
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
}
export function scheduledIso(local: string, timezone = "Asia/Manila") {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw Error("Enter a valid interview date and time.");
  const wall = Date.parse(local + "Z");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(wall));
  const get = (k: string) => parts.find((p) => p.type === k)?.value;
  const zoned = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
  );
  return new Date(wall - (zoned - wall)).toISOString();
}
