import type { AppState, QualificationTemplate } from "@/types";
import {
  applicationSearchQuery,
  GMAIL_APPLICATION_QUERY,
} from "@/lib/intake-detector";

const baselineTemplates: QualificationTemplate[] = [
  {
    id: "Barista",
    position: "Barista",
    minimum: [
      "1 year barista experience",
      "Customer service experience",
      "Available for shifting schedule",
      "High school graduate or equivalent",
    ].join("\n"),
    preferred: "",
    criteria:
      "Baseline checklist — HR should adjust this to the approved job requirement.",
    questions:
      "Confirm unclear qualifications and work-location preference during HR review.",
    rules: [
      "1 year barista experience",
      "Customer service experience",
      "Available for shifting schedule",
      "High school graduate or equivalent",
    ].map((label, index) => ({
      id: `baseline-barista-${index}`,
      label,
      kind: "Minimum" as const,
      absenceFails: false,
    })),
  },
  {
    id: "Team Leader",
    position: "Team Leader",
    minimum: [
      "Team leadership experience",
      "Customer service experience",
      "Available for shifting schedule",
    ].join("\n"),
    preferred: "",
    criteria:
      "Baseline checklist — HR should adjust this to the approved job requirement.",
    questions:
      "Confirm unclear qualifications and work-location preference during HR review.",
    rules: [
      "Team leadership experience",
      "Customer service experience",
      "Available for shifting schedule",
    ].map((label, index) => ({
      id: `baseline-team-leader-${index}`,
      label,
      kind: "Minimum" as const,
      absenceFails: false,
    })),
  },
  {
    id: "Supervisor",
    position: "Supervisor",
    minimum: [
      "Supervisory experience",
      "Staff scheduling experience",
      "Customer service experience",
    ].join("\n"),
    preferred: "",
    criteria:
      "Baseline checklist — HR should adjust this to the approved job requirement.",
    questions:
      "Confirm unclear qualifications and work-location preference during HR review.",
    rules: [
      "Supervisory experience",
      "Staff scheduling experience",
      "Customer service experience",
    ].map((label, index) => ({
      id: `baseline-supervisor-${index}`,
      label,
      kind: "Minimum" as const,
      absenceFails: false,
    })),
  },
];

const baselineLocations = [
  {
    id: "naga",
    name: "Naga City",
    city: "Naga City",
    province: "Camarines Sur",
  },
  {
    id: "santa-rosa",
    name: "Santa Rosa, Laguna",
    city: "Santa Rosa",
    province: "Laguna",
  },
];

const key = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const legacyIntakeQuery =
  "has:attachment {subject:application subject:applying subject:resume subject:cv} -in:spam -in:trash -in:sent";
// Label-free detection is the default for both new workspaces and old installs.

/**
 * Older releases encouraged subject and attachment gates. Those gates are not
 * suitable for this mailbox: applications can use a person's name, a branch
 * name, or no subject at all, and no HR label is required. Treat
 * those shipped-style filters as legacy even if spacing or one of the subject
 * terms was edited, but preserve deliberate custom search filters.
 */
function isRestrictiveLegacyIntakeQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === legacyIntakeQuery) return true;
  if (/\blabel\s*:/.test(normalized)) return false;
  return /\bsubject\s*:\s*(application|applying|resume|cv)\b/.test(normalized);
}

/**
 * Repair only absent/empty baseline configuration. Existing HR-authored rules
 * and locations always win; each non-demo hiring need also supplies a valid
 * location entry when it is not already configured.
 */
export function ensureRecruitmentConfiguration(state: AppState) {
  let updated = 0;
  // Replace shipped subject gates and the former HR label requirement.
  const query = applicationSearchQuery(state.intakeQuery);
  if (
    query !== state.intakeQuery ||
    isRestrictiveLegacyIntakeQuery(state.intakeQuery || "")
  ) {
    state.intakeQuery = GMAIL_APPLICATION_QUERY;
    updated++;
  }
  for (const baseline of baselineTemplates) {
    const existing = state.qualifications.find(
      (template) => key(template.position) === key(baseline.position),
    );
    if (!existing) {
      state.qualifications.push(structuredClone(baseline));
      updated++;
    } else if (!existing.rules?.length) {
      Object.assign(existing, {
        ...structuredClone(baseline),
        id: existing.id,
        position: existing.position,
      });
      updated++;
    }
  }
  state.locations ||= [];
  const addLocation = (name: string, city: string, province: string) => {
    if (
      !name.trim() ||
      state.locations!.some((location) => key(location.name) === key(name))
    )
      return;
    state.locations!.push({
      id: `system-${key(name).replaceAll(" ", "-")}`.slice(0, 100),
      name,
      city,
      province,
      active: true,
    });
    updated++;
  };
  for (const location of baselineLocations)
    addLocation(location.name, location.city, location.province);
  for (const need of state.hiringNeeds.filter((item) => !item.isDemo)) {
    const parts = need.location.split(",").map((part) => part.trim());
    if (
      !need.location ||
      /not clearly stated|not verified|unassigned/i.test(need.location)
    )
      continue;
    addLocation(
      need.location.trim(),
      parts[0] || need.location.trim(),
      parts.slice(1).join(", "),
    );
  }
  return updated;
}

export function baselineQualificationTemplates() {
  return structuredClone(baselineTemplates);
}
