import type {
  AppState,
  HiringNeed,
  Location,
  QualificationRule,
} from "@/types";

// Transcribed from the company vacancies report dated 21 September 2026.
// The report supplies branch, position and slots; HR supplied 15 October 2026
// as the target date. It does not state formal qualification requirements.
// The 15 itemized Operations rows sum to 18, although the printed total is 19.
// Do not invent a branch assignment for the unmatched slot.
export const vacancyReport20260921 = [
  ["ops-01", "Barista", "Tagapo", 1],
  ["ops-02", "Barista", "Naic", 1],
  ["ops-03", "Barista", "Gen. Tri", 3],
  ["ops-04", "Team Leader", "Gen. Tri", 1],
  ["ops-05", "Barista", "SM San Pedro", 2],
  ["ops-06", "Team Leader", "SM San Pedro", 1],
  ["ops-07", "Barista-Reliever", "Magsaysay", 1],
  ["ops-08", "Barista", "Naga City", 1],
  ["ops-09", "Barista", "Washington", 1],
  ["ops-10", "Area Supervisor", "Daet & Sipocot", 1],
  ["ops-11", "Barista", "Goa", 1],
  ["ops-12", "Area Supervisor", "Legazpi", 1],
  ["ops-13", "Barista", "Sorsogon", 1],
  ["ops-14", "Supervisor", "Pili", 1],
  ["ops-15", "Barista", "Pili", 1],
  ["admin-01", "Business Development Manager", "Head Office — CALABARZON", 1],
  ["admin-02", "Social Media Manager", "Head Office — Bicol", 1],
] as const;

const draftCriteria: Record<string, string[]> = {
  Barista: [
    "Customer service experience",
    "Coffee or beverage preparation experience",
    "Branch schedule availability",
  ],
  "Barista-Reliever": [
    "Coffee or beverage preparation experience",
    "Customer service experience",
    "Relief schedule availability",
  ],
  "Team Leader": [
    "Team coordination experience",
    "Customer service experience",
    "Operational reporting experience",
  ],
  Supervisor: [
    "Frontline supervision experience",
    "Staff scheduling experience",
    "Customer service experience",
  ],
  "Area Supervisor": [
    "Multi-branch operations experience",
    "Staff coaching experience",
    "Operational reporting experience",
  ],
  "Business Development Manager": [
    "Business development experience",
    "Partnership or client relationship experience",
    "Planning and reporting experience",
  ],
  "Social Media Manager": [
    "Social media content planning experience",
    "Campaign performance reporting experience",
    "Audience engagement experience",
  ],
};

const key = (position: string, location: string) =>
  `${position.trim().toLocaleLowerCase()}|${location.trim().toLocaleLowerCase()}`;

export function planVacancyReportImport(state: AppState) {
  const existing = new Set(
    state.hiringNeeds
      .filter((need) => !need.isDemo && !need.id.startsWith("sample-need-"))
      .map((need) => key(need.position, need.location)),
  );
  const knownLocations = new Set(
    (state.locations || []).map((location) =>
      location.name.toLocaleLowerCase(),
    ),
  );
  const locations: Location[] = [];
  const needs: HiringNeed[] = [];
  let skipped = 0;
  for (const [row, position, location, slots] of vacancyReport20260921) {
    if (!knownLocations.has(location.toLocaleLowerCase())) {
      locations.push({
        id: `report-2026-09-21-location-${location.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: location,
        city: location === "Naga City" ? "Naga City" : "",
        province: location === "Naga City" ? "Camarines Sur" : "",
        active: true,
      });
      knownLocations.add(location.toLocaleLowerCase());
    }
    if (existing.has(key(position, location))) {
      skipped++;
      continue;
    }
    const criteria: QualificationRule[] = draftCriteria[position].map(
      (label, index) => ({
        id: `report-2026-09-21-${row}-criterion-${index + 1}`,
        label,
        kind: "Preferred",
        absenceFails: false,
      }),
    );
    needs.push({
      id: `report-2026-09-21-${row}`,
      position,
      location,
      slots,
      filled: 0,
      urgency: "High",
      targetDate: "2026-10-15",
      status: "Open",
      criteria,
      qualifications:
        "Draft role-specific criteria for HR review; not stated in the 21 September 2026 vacancies report.",
      questions:
        "Confirm relevant experience, work-location preference and availability during HR review.",
    });
    existing.add(key(position, location));
  }
  return { locations, needs, skipped };
}
