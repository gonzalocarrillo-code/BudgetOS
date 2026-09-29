import { z } from "zod";

/**
 * GET /workspaces/:ws/overview (T-033, ADR-029, docs/HOME_OVERVIEW_PLAN.md): the Overview dashboard in
 * one response. Every number comes from the planner or a count on the server; the page never sums,
 * sorts or ranks. Money and ratios are decimal strings.
 */
const Num = z.string().nullable().optional();

/** A live leaf budget in a ranked list, with the planner's measures. */
export const OverviewLeaf = z
  .object({ envelopeId: z.string().uuid().nullable(), name: z.string(), path: z.array(z.string()), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num })
  .passthrough();
export type OverviewLeaf = z.infer<typeof OverviewLeaf>;

export const OverviewHeatmapCell = z.object({ row: z.string().nullable(), col: z.string().nullable(), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num }).passthrough();
export type OverviewHeatmapCell = z.infer<typeof OverviewHeatmapCell>;

export const OverviewHeatmap = z.object({
  rowDimension: z.object({ key: z.string(), label: z.string() }),
  colDimension: z.object({ key: z.string(), label: z.string() }),
  /** Row and column values, by budget, largest first (the page shows the first ones, then "Show all"). */
  rows: z.array(z.string()),
  cols: z.array(z.string()),
  labels: z.object({ rows: z.record(z.string(), z.string()), cols: z.record(z.string(), z.string()) }),
  cells: z.array(OverviewHeatmapCell),
  /** The registry's granularities, for the rows and columns pickers. */
  dimensions: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
});
export type OverviewHeatmap = z.infer<typeof OverviewHeatmap>;

export const OverviewResponse = z.object({
  currency: z.string(),
  period: z.object({ preset: z.string(), start: z.string().optional(), end: z.string().optional(), elapsed: z.string().optional() }).passthrough(),
  dataAsOf: z.string(),
  totals: z.record(z.string(), z.string().nullable()),
  /** UX-008 (ADR-051): the tiles' budget, as Budgets counts it; `assigned` is what the leaves (the heatmap) hold. */
  headline: z.object({ basis: z.string(), budget: z.string().nullable(), actual: z.string().nullable(), spentPct: z.string().nullable(), paceIndex: z.string().nullable(), assigned: z.string().nullable() }).nullable().optional(),
  heatmap: OverviewHeatmap.nullable(),
  variances: z.object({ over: z.array(OverviewLeaf), under: z.array(OverviewLeaf) }),
  kpi: z
    .object({
      metric: z.string(),
      dimension: z.object({ key: z.string(), label: z.string() }),
      rows: z.array(z.object({ code: z.string().nullable(), label: z.string().nullable(), budget: Num, actual: Num, target: Num, vsTargetPct: Num })),
    })
    .nullable(),
  /** Open alerts (OPEN_ALERT_STATUSES) the caller may read: the same count as Home's. */
  alerts: z.object({
    open: z.number(),
    counts: z.record(z.string(), z.number()),
    latest: z.array(z.object({ id: z.string(), severity: z.string(), envelopeId: z.string(), envelopeName: z.string().nullable(), ruleName: z.string().nullable() }).passthrough()),
  }),
  approvals: z.object({ mine: z.number(), overdue: z.number(), due: z.array(z.object({ id: z.string(), summary: z.string().nullable(), dueAt: z.string().nullable(), requestedByName: z.string().nullable().optional() }).passthrough()) }),
  freshness: z.object({
    lastFactDate: z.string().nullable(),
    sources: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), isActive: z.boolean(), lastRun: z.object({ status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), matchCoverage: z.string().nullable() }).nullable() })),
  }),
  elapsedMs: z.number(),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;
