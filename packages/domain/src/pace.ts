/**
 * Pace bands (docs/HOME_OVERVIEW_PLAN.md §3.3, HO-001): how Home and the Overview colour a pace
 * index, with the same thresholds in every legend and every cell. Pace is spend against the budget's
 * share of the time gone (ADR-047); 1.00 is on plan. Each band's `max` is exclusive and the bands are
 * contiguous, so every pace falls in exactly one. The timeline's bar states (`paceStateOf`) keep their
 * own alert-oriented thresholds.
 */
export const PACE_BANDS = [
  { key: "under", max: 0.8 },
  { key: "low", max: 0.95 },
  { key: "on", max: 1.05 },
  { key: "high", max: 1.2 },
  { key: "over", max: Number.POSITIVE_INFINITY },
] as const;

export type PaceBandKey = (typeof PACE_BANDS)[number]["key"];

/** The on-plan band as a range: a pace from `from` (inclusive) to `to` (exclusive) is on plan. */
export const ON_PLAN = { from: 0.95, to: 1.05 } as const;

/** The band a pace index falls in; null when there is no pace (no budget in the period, or no time gone). */
export function paceBand(pace: string | number | null | undefined): PaceBandKey | null {
  if (pace === null || pace === undefined || pace === "") return null;
  const n = typeof pace === "number" ? pace : Number(pace);
  if (!Number.isFinite(n)) return null;
  return (PACE_BANDS.find((b) => n < b.max) ?? PACE_BANDS[4]).key;
}
