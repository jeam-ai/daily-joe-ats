// Bounded process-local fallback when persistence itself fails. It deliberately
// contains no exception text, credentials, document contents or request headers.
const pending = new Map<
  string,
  {
    category: "database.unavailable" | "server.failure";
    at: string;
    count: number;
  }
>();
export function bufferFailure(
  category: "database.unavailable" | "server.failure",
) {
  const previous = pending.get(category);
  pending.set(category, {
    category,
    at: new Date().toISOString(),
    count: (previous?.count || 0) + 1,
  });
  if (!previous)
    console.error(
      "Daily Joe Careers diagnostic:",
      category,
      "(awaiting persistence)",
    );
}
export function pendingFailures() {
  return [...pending.values()];
}
export function clearBufferedFailure(category: string) {
  pending.delete(category);
}
export function isDatabaseFailure(error: unknown) {
  const e = error as { code?: string; message?: string };
  return (
    /^(08|53|57P|ETIMEDOUT|ECONNREFUSED|ECONNRESET)/.test(e?.code || "") ||
    /connection (?:terminated|timeout)|timeout exceeded when trying to connect|query read timeout/i.test(
      e?.message || "",
    )
  );
}
