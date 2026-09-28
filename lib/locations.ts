import type { AppState, Location } from "@/types";

const generalTriasAlias = /^(?:gen\.?\s*tri(?:as)?|general\s+trias)$/i;

type BranchGeography = {
  city: string;
  province: string;
  /** Specific locality cues that can safely select a branch from a residence. */
  nearby: string[];
};

const branchGeography: Record<string, BranchGeography> = {
  tagapo: {
    city: "Santa Rosa",
    province: "Laguna",
    nearby: ["Tagapo", "Santa Rosa", "Sta. Rosa"],
  },
  naic: { city: "Naic", province: "Cavite", nearby: ["Naic"] },
  "general trias": {
    city: "General Trias",
    province: "Cavite",
    nearby: ["General Trias", "Gen. Tri"],
  },
  "sm san pedro": {
    city: "San Pedro",
    province: "Laguna",
    nearby: ["San Pedro", "Pacita"],
  },
  magsaysay: {
    city: "Naga City",
    province: "Camarines Sur",
    nearby: ["Magsaysay", "Concepcion Pequena"],
  },
  washington: {
    city: "Legazpi City",
    province: "Albay",
    nearby: ["Washington Drive", "F. Aquende", "Aquende", "Kawit East"],
  },
  daet: {
    city: "Daet",
    province: "Camarines Norte",
    nearby: ["Daet"],
  },
  sipocot: {
    city: "Sipocot",
    province: "Camarines Sur",
    nearby: ["Sipocot"],
  },
  goa: { city: "Goa", province: "Camarines Sur", nearby: ["Goa"] },
  legazpi: {
    city: "Legazpi City",
    province: "Albay",
    nearby: ["Old Albay", "Kapantawan"],
  },
  sorsogon: {
    city: "Sorsogon City",
    province: "Sorsogon",
    nearby: ["Sorsogon"],
  },
  pili: { city: "Pili", province: "Camarines Sur", nearby: ["Pili"] },
  "head office calabarzon": {
    city: "Lucena City",
    province: "Quezon",
    nearby: [],
  },
  "head office bicol": {
    city: "Naga City",
    province: "Camarines Sur",
    nearby: [],
  },
};

const normalizedKey = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[—–&]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const escapedPattern = (value: string) =>
  value
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

const includesPlace = (address: string, place: string) =>
  place.trim().length > 2 &&
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapedPattern(place)}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(address);

export function canonicalLocationName(name: string) {
  return generalTriasAlias.test(name.trim()) ? "General Trias" : name.trim();
}

export function branchGeographyFor(name: string) {
  return branchGeography[normalizedKey(canonicalLocationName(name))];
}

/**
 * Resolve a residence to one configured active branch only when the evidence
 * identifies one branch. City-only matches are accepted only if that city has
 * one active configured branch; this avoids guessing between Washington and
 * Legazpi City.
 */
export function nearbyConfiguredBranch(
  residence: string,
  locations: Pick<Location, "name" | "city" | "province" | "active">[],
) {
  if (!residence || /not verified|not clearly stated/i.test(residence))
    return "";
  const active = locations.filter((location) => location.active);
  const nearby = active.filter((location) => {
    const geography = branchGeographyFor(location.name);
    return (geography?.nearby || []).some((signal) =>
      includesPlace(residence, signal),
    );
  });
  const distinctNearby = [...new Set(nearby.map((location) => location.name))];
  if (distinctNearby.length === 1) return distinctNearby[0];

  const named = active.filter((location) =>
    includesPlace(residence, location.name),
  );
  const distinctNamed = [...new Set(named.map((location) => location.name))];
  if (distinctNamed.length === 1) return distinctNamed[0];

  const cityMatches = active.filter((location) => {
    const city = location.city || branchGeographyFor(location.name)?.city || "";
    return includesPlace(residence, city);
  });
  const distinctCityMatches = [
    ...new Set(cityMatches.map((location) => location.name)),
  ];
  return distinctCityMatches.length === 1 ? distinctCityMatches[0] : "";
}

// Correct historic aliases and enrich the displayed geography without
// changing location IDs, hiring-need identities, or HR-verified assignments.
export function canonicalizeStoredLocations(state: AppState) {
  let changed = 0;
  const locations = state.locations || [];
  let canonicalSeen = locations.some(
    (location) => location.name === "General Trias",
  );
  state.locations = locations.filter((location) => {
    if (
      !generalTriasAlias.test(location.name) ||
      location.name === "General Trias"
    )
      return true;
    changed++;
    if (canonicalSeen) return false;
    location.name = "General Trias";
    location.city ||= "General Trias";
    canonicalSeen = true;
    return true;
  });
  const combinedDaetSipocot = state.locations.find(
    (location) => normalizedKey(location.name) === "daet sipocot",
  );
  if (combinedDaetSipocot) {
    state.locations = state.locations.filter(
      (location) => location !== combinedDaetSipocot,
    );
    for (const [name, city, province] of [
      ["Daet", "Daet", "Camarines Norte"],
      ["Sipocot", "Sipocot", "Camarines Sur"],
    ]) {
      if (
        state.locations.some(
          (location) => normalizedKey(location.name) === normalizedKey(name),
        )
      )
        continue;
      state.locations.push({
        id: `${combinedDaetSipocot.id}-${normalizedKey(name)}`.slice(0, 100),
        name,
        city,
        province,
        active: combinedDaetSipocot.active,
      });
    }
    changed++;
  }
  for (const location of state.locations) {
    const geography = branchGeographyFor(location.name);
    if (!geography) continue;
    if (
      location.city !== geography.city ||
      location.province !== geography.province
    ) {
      location.city = geography.city;
      location.province = geography.province;
      changed++;
    }
  }
  for (const need of state.hiringNeeds) {
    if (normalizedKey(need.location) === "daet sipocot") {
      need.location = "Daet";
      changed++;
      const sipocotId = `${need.id}-sipocot`.slice(0, 100);
      if (!state.hiringNeeds.some((item) => item.id === sipocotId)) {
        state.hiringNeeds.push({
          ...structuredClone(need),
          id: sipocotId,
          location: "Sipocot",
          // Daet and Sipocot are separate active hiring needs. Keep the
          // originally approved deadline and requirement set for both.
          status: need.status,
          filled: 0,
        });
        changed++;
      }
    }
    if (
      generalTriasAlias.test(need.location) &&
      need.location !== "General Trias"
    ) {
      need.location = "General Trias";
      changed++;
    }
  }
  for (const application of state.applications) {
    if (
      generalTriasAlias.test(application.location) &&
      application.location !== "General Trias"
    ) {
      application.location = "General Trias";
      changed++;
    }
    if (
      application.assignedBranch &&
      generalTriasAlias.test(application.assignedBranch) &&
      application.assignedBranch !== "General Trias"
    ) {
      application.assignedBranch = "General Trias";
      changed++;
    }
    if (
      normalizedKey(application.assignedBranch || "") === "daet sipocot" &&
      !application.information?.fields.assignedBranch?.verifiedBy
    ) {
      application.assignedBranch = undefined;
      changed++;
    }
    const assigned = nearbyConfiguredBranch(
      application.applicant?.location || "",
      state.locations,
    );
    if (
      assigned &&
      (!application.assignedBranch ||
        /^unassigned$/i.test(application.assignedBranch)) &&
      !application.information?.fields.assignedBranch?.verifiedBy
    ) {
      application.assignedBranch = assigned;
      application.information ||= { fields: {}, conflicts: [] };
      application.information.fields.assignedBranch = {
        source: "Residence match",
        evidence: `Nearby configured branch: ${assigned}.`,
        confidence: "Confident",
      };
      changed++;
    }
  }
  return changed;
}
