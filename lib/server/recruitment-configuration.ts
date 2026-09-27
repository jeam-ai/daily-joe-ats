import type { AppState, QualificationTemplate } from "@/types";

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
const labeledIntakeQuery =
  'label:"HR - Applications" -in:spam -in:trash -in:sent';

/**
 * Repair only absent/empty baseline configuration. Existing HR-authored rules
 * and locations always win; each non-demo hiring need also supplies a valid
 * location entry when it is not already configured.
 */
export function ensureRecruitmentConfiguration(state: AppState) {
  let updated = 0;
  // The old subject-only query skipped valid applications titled with a name,
  // branch, or no subject. Upgrade only that shipped default; an HR-authored
  // custom Gmail query is never overwritten.
  if (
    !state.intakeQuery?.trim() ||
    state.intakeQuery.trim() === legacyIntakeQuery
  ) {
    state.intakeQuery = labeledIntakeQuery;
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
