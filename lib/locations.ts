import type { AppState } from "@/types";

const generalTriasAlias = /^(?:gen\.?\s*tri(?:as)?|general\s+trias)$/i;

export function canonicalLocationName(name: string) {
  return generalTriasAlias.test(name.trim()) ? "General Trias" : name.trim();
}

// Correct a previously imported abbreviation without changing the identity of
// any hiring request or application. Location IDs are not referenced elsewhere.
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
  for (const need of state.hiringNeeds)
    if (
      generalTriasAlias.test(need.location) &&
      need.location !== "General Trias"
    ) {
      need.location = "General Trias";
      changed++;
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
  }
  return changed;
}
