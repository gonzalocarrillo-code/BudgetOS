import { Decimal } from "decimal.js";

/**
 * The planner's ratio measures over a group, from its sums (compile-query.ts `ratioExpr`, ADR-038):
 * recomputed from Σbudget, Σactual and Σprojected, never averaged. The roll-up worker stores them;
 * /tree recomputes them for the reading day, since pace depends on today and a cached node does not
 * change when nothing else does.
 */

/** The elapsed fraction of the period at `today`, clamped to [0, 1] (the planner's `elapsedFrac`). */
export function elapsedFraction(period: { start: string; end: string }, today: string): Decimal {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const len = day(period.end) - day(period.start) + 1;
  if (len <= 0) return new Decimal(0);
  return Decimal.min(1, Decimal.max(0, new Decimal(day(today) - day(period.start) + 1).div(len)));
}

export interface GroupSums {
  budget: Decimal | null;
  actual: Decimal | null;
  projected: Decimal | null;
}

export function groupRatios(x: GroupSums, elapsed: Decimal): Record<"pace_index" | "spend_to_date_pct" | "projected_close_pct" | "variance_pct", string | null> {
  const budget = x.budget !== null && x.budget.gt(0) ? x.budget : null;
  const ratio = (n: Decimal | null) => (budget === null || n === null ? null : n.div(budget).toString());
  return {
    pace_index: budget === null || x.actual === null || elapsed.lte(0) ? null : x.actual.div(budget).div(elapsed).toString(),
    spend_to_date_pct: ratio(x.actual),
    projected_close_pct: ratio(x.projected),
    variance_pct: budget === null || x.projected === null ? null : x.projected.minus(budget).div(budget).toString(),
  };
}
