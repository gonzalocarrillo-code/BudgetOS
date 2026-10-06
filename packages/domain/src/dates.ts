/**
 * The business day is the UTC date (ADR-041 fiscal calendar; workspaces have no time zone yet).
 * This function returns today's date in UTC as an ISO string (YYYY-MM-DD format).
 * A call west of UTC in the evening will return tomorrow's UTC date.
 *
 * @param now - Optional Date object; defaults to new Date()
 * @returns The UTC date as an ISO string (YYYY-MM-DD)
 */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
