import type { ColumnSpec, QueryRow } from "../src/types.js";

export const BUDGET_ROW_COUNT = 100_000;

export const BUDGET_COLUMNS: ColumnSpec[] = [
  { kind: "path" },
  { kind: "measure", key: "budget" },
  { kind: "measure", key: "actual" },
  { kind: "measure", key: "projected" },
  { kind: "measure", key: "variance_abs" },
  { kind: "measure", key: "variance_pct" },
  { kind: "measure", key: "remaining" },
  { kind: "measure", key: "pace_index" },
  { kind: "target", metric: "cpa", field: "target" },
  { kind: "status" },
  { kind: "chips" },
  { kind: "dimension", key: "country" },
];

export function budgetRow(index: number): QueryRow {
  const n = index + 1;
  return {
    key: `row-${n}`,
    envelopeId: null,
    depth: 1,
    path: [`region-${n % 8}`, `envelope-${n}`],
    dimensions: { country: `country-${n % 40}` },
    measures: {
      budget: (1000 + (n % 5000)).toFixed(2),
      actual: (800 + (n % 4000)).toFixed(2),
      projected: (900 + (n % 4500)).toFixed(2),
      variance_abs: (n % 200).toFixed(2),
      variance_pct: ((n % 100) / 100).toFixed(2),
      remaining: (200 + (n % 1000)).toFixed(2),
      pace_index: ((n % 150) / 100).toFixed(2),
    },
    targets: { cpa: { target: (50 + (n % 80)).toFixed(2), actual: null, vsTargetPct: null } },
    status: n % 5 === 0 ? "pending" : "approved",
    pendingCount: n % 4,
    openAlerts: n % 3,
    openThreads: n % 2,
  };
}
