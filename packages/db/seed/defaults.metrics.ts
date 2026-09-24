/**
 * Default metric library (plan §4.8: budget, CPA, CPL, CPM, CPC, CTR, ROAS, conversions, revenue,
 * impressions, reach). A metric is a numerator over a denominator of `spend`, `budget` or
 * `kpi:<fact metric>`; the planner divides the sums at every roll-up level and applies the
 * multiplier after dividing. Admins add more through POST /workspaces/:ws/metrics, no deploy.
 *
 * Reach is not additive across envelopes (the same person counts once per envelope); its roll-up is
 * a sum of reaches, an upper bound. Deduplicated reach needs person-level data the facts do not have.
 */
export interface DefaultMetricSeed {
  key: string;
  label: string;
  numerator: string;
  denominator: string | null;
  multiplier: string;
  direction: "lower_is_better" | "higher_is_better";
  format: "currency" | "number" | "percent" | "ratio";
}

export const DEFAULT_METRICS: readonly DefaultMetricSeed[] = [
  { key: "budget", label: "Budget", numerator: "budget", denominator: null, multiplier: "1", direction: "lower_is_better", format: "currency" },
  { key: "cpa", label: "CPA", numerator: "spend", denominator: "kpi:conversions", multiplier: "1", direction: "lower_is_better", format: "currency" },
  { key: "cpl", label: "CPL", numerator: "spend", denominator: "kpi:leads", multiplier: "1", direction: "lower_is_better", format: "currency" },
  { key: "cpm", label: "CPM", numerator: "spend", denominator: "kpi:impressions", multiplier: "1000", direction: "lower_is_better", format: "currency" },
  { key: "cpc", label: "CPC", numerator: "spend", denominator: "kpi:clicks", multiplier: "1", direction: "lower_is_better", format: "currency" },
  { key: "ctr", label: "CTR", numerator: "kpi:clicks", denominator: "kpi:impressions", multiplier: "1", direction: "higher_is_better", format: "percent" },
  { key: "roas", label: "ROAS", numerator: "kpi:revenue", denominator: "spend", multiplier: "1", direction: "higher_is_better", format: "ratio" },
  { key: "conversions", label: "Conversions", numerator: "kpi:conversions", denominator: null, multiplier: "1", direction: "higher_is_better", format: "number" },
  { key: "revenue", label: "Revenue", numerator: "kpi:revenue", denominator: null, multiplier: "1", direction: "higher_is_better", format: "currency" },
  { key: "impressions", label: "Impressions", numerator: "kpi:impressions", denominator: null, multiplier: "1", direction: "higher_is_better", format: "number" },
  { key: "reach", label: "Reach", numerator: "kpi:reach", denominator: null, multiplier: "1", direction: "higher_is_better", format: "number" },
];
