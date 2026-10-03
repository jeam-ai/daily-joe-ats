export type ApplicantNeighbors = {
  previousId: string | null;
  nextId: string | null;
  position: number;
  total: number;
};

// Reuse the server's filtered order while its next lookup runs. Store only IDs,
// scoped to the signed-in user, dataset, filters and workspace revision.
const navigationCache = new Map<
  string,
  { neighbors: ApplicantNeighbors; expiresAt: number }
>();
export function applicantNavigationScope(
  listContext: string,
  dataset: string,
  email = "",
  revision: string | number = 0,
) {
  const filters = new URLSearchParams(listContext);
  for (const key of ["page", "limit", "around", "selection"])
    filters.delete(key);
  filters.sort();
  return JSON.stringify([
    email.toLowerCase(),
    dataset,
    revision,
    filters.toString(),
  ]);
}
export function rememberApplicantNavigation(
  scope: string,
  entries: Record<string, ApplicantNeighbors>,
) {
  for (const [id, neighbors] of Object.entries(entries)) {
    const key = JSON.stringify([scope, id]);
    navigationCache.delete(key);
    navigationCache.set(key, { neighbors, expiresAt: Date.now() + 60_000 });
  }
  while (navigationCache.size > 200)
    navigationCache.delete(navigationCache.keys().next().value!);
}
export function cachedApplicantNavigation(scope: string, id: string) {
  const key = JSON.stringify([scope, id]);
  const cached = navigationCache.get(key);
  if (!cached || cached.expiresAt < Date.now()) {
    navigationCache.delete(key);
    return null;
  }
  return cached.neighbors;
}
