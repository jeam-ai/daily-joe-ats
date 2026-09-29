/**
 * Timekeeping is a short-lived payroll review workspace. Both half-month
 * analyses for a calendar month stay available through the second payroll
 * date (the 5th of the following month) plus HR's final grace period.
 */
export const defaultTimekeepingCutoffGraceDays = 5;

export function timekeepingCutoffExpiresAt(
  periodEnd: string,
  graceDays = defaultTimekeepingCutoffGraceDays,
) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodEnd);
  if (!match || !Number.isInteger(graceDays) || graceDays < 0) return null;
  const [, year, month, day] = match.map(Number);
  const periodDate = new Date(Date.UTC(year, month - 1, day));
  if (
    periodDate.getUTCFullYear() !== year ||
    periodDate.getUTCMonth() !== month - 1 ||
    periodDate.getUTCDate() !== day
  )
    return null;

  // JavaScript month indexes are zero-based. Passing the source month gives
  // the following calendar month, including the December → January rollover.
  return new Date(
    Date.UTC(year, month, 5 + graceDays, 23, 59, 59, 999),
  ).toISOString();
}

export function timekeepingRetentionLabel(graceDays: number) {
  return `Both half-month cutoffs are retained through the 5th of the following month plus ${graceDays} grace day${graceDays === 1 ? "" : "s"}.`;
}
