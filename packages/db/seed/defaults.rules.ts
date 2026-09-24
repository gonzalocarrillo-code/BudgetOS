/**
 * Default pacing rules (plan §8.4). Thresholds are decimal strings; `kpi_vs_target_pct` is actual /
 * target, so "CPA > 110% of target" is `gt 1.10` (for a higher-is-better KPI such as ROAS a rule
 * would use `lt`). `implied_volume_gap` is (projected conversions − implied) / implied: a shortfall
 * of more than 15% is `lt -0.15`.
 *
 * Not shipped yet: "unmatched spend > 2%" (data). It is a workspace-level alert, and alert and
 * rule_state are keyed by envelope; it waits for the data-quality screen (ADR-012).
 */
export interface DefaultRuleSeed {
  name: string;
  metric: string;
  metricArgs: Record<string, unknown>;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: string;
  consecutiveDays: number;
  severity: "info" | "warning" | "critical" | "data";
}

export const DEFAULT_RULES: readonly DefaultRuleSeed[] = [
  { name: "Over-pace", metric: "pace_index", metricArgs: {}, comparator: "gt", threshold: "1.10", consecutiveDays: 3, severity: "warning" },
  { name: "Projected overrun", metric: "projected_close_pct", metricArgs: {}, comparator: "gt", threshold: "1.05", consecutiveDays: 1, severity: "critical" },
  { name: "Projected underspend near close", metric: "projected_close_pct", metricArgs: { daysRemainingLt: 30 }, comparator: "lt", threshold: "0.85", consecutiveDays: 1, severity: "warning" },
  { name: "CPA over target", metric: "kpi_vs_target_pct", metricArgs: { metricKey: "cpa" }, comparator: "gt", threshold: "1.10", consecutiveDays: 3, severity: "warning" },
  { name: "CPA far over target", metric: "kpi_vs_target_pct", metricArgs: { metricKey: "cpa" }, comparator: "gt", threshold: "1.25", consecutiveDays: 1, severity: "critical" },
  { name: "Implied volume gap", metric: "implied_volume_gap", metricArgs: {}, comparator: "lt", threshold: "-0.15", consecutiveDays: 1, severity: "warning" },
];
