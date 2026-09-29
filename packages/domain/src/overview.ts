import { z } from "zod";

/**
 * GET /workspaces/:ws/overview (T-033, ADR-029, docs/HOME_OVERVIEW_PLAN.md §3.2): the Overview
 * dashboard in one response. Every number comes from the planner or a count on the server; the page
 * never sums, sorts or ranks. Money and ratios are decimal strings.
 */
const Num = z.string().nullable().optional();

/**
 * HO-003 (ADR-062): how current the actuals are. `through` is the last day they cover (the end of the
 * month for a monthly source), capped at today; time gone and pace are counted through it.
 */
export const DataAsOfView = z.object({
  lastFactDate: z.string().nullable(),
  through: z.string().nullable(),
  grain: z.enum(["day", "month"]).nullable(),
  staleDays: z.number().int().nullable(),
  stale: z.boolean(),
});
export type DataAsOfView = z.infer<typeof DataAsOfView>;

/** The planner's measures the Overview reads for a cell, a margin or a budget. */
const MEASURES = { budget: Num, budget_in_period: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num, ahead_of_plan_abs: Num };

/** A live leaf budget in a ranked list, with the planner's measures. */
export const OverviewLeaf = z
  .object({ envelopeId: z.string().uuid().nullable(), name: z.string(), path: z.array(z.string()), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num })
  .passthrough();
export type OverviewLeaf = z.infer<typeof OverviewLeaf>;

/** One heatmap cell: its measures, its open alerts and budgets waiting; with Compare to, the budget then. */
export const OverviewHeatmapCell = z
  .object({ row: z.string().nullable(), col: z.string().nullable(), ...MEASURES, budget_baseline: Num, budget_change_abs: Num, alerts: z.number().int().default(0), pending: z.number().int().default(0) })
  .passthrough();
export type OverviewHeatmapCell = z.infer<typeof OverviewHeatmapCell>;

/** A row's or a column's total (HO-010): the heatmap's margins, from the planner, not summed on the page. */
export const OverviewMargin = z.object({ code: z.string().nullable(), ...MEASURES, alerts: z.number().int().default(0) }).passthrough();
export type OverviewMargin = z.infer<typeof OverviewMargin>;

export const HEATMAP_SORTS = ["budget", "pace", "ahead"] as const;

export const OverviewHeatmap = z.object({
  rowDimension: z.object({ key: z.string(), label: z.string() }),
  colDimension: z.object({ key: z.string(), label: z.string() }),
  /** Row values in the chosen order (`sort`), column values by budget, largest first. */
  rows: z.array(z.string()),
  cols: z.array(z.string()),
  labels: z.object({ rows: z.record(z.string(), z.string()), cols: z.record(z.string(), z.string()) }),
  cells: z.array(OverviewHeatmapCell),
  /** The registry's granularities, for the rows and columns pickers. */
  dimensions: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
  rowTotals: z.array(OverviewMargin).default([]),
  colTotals: z.array(OverviewMargin).default([]),
  total: z.object(MEASURES).passthrough().nullable().default(null),
  sort: z.enum(HEATMAP_SORTS).default("budget"),
});
export type OverviewHeatmap = z.infer<typeof OverviewHeatmap>;

export const ATTENTION_CATEGORIES = ["over", "under", "no_spend", "kpi"] as const;

/**
 * A budget that needs attention (HO-010, ADR-064), ranked by money at stake (`money`): ahead of or
 * behind plan (`ahead_of_plan_abs`), what it should have spent by now when it has spent nothing, or
 * what its CPA costs above target (spend × (1 − target ÷ actual CPA)).
 */
export const OverviewAttentionItem = z.object({
  category: z.enum(ATTENTION_CATEGORIES),
  envelopeId: z.string().uuid(),
  name: z.string(),
  path: z.array(z.string()),
  ...MEASURES,
  money: z.string(),
  alerts: z.number().int(),
  pending: z.boolean(),
  endDate: z.string().nullable(),
  kpi: z.object({ metric: z.string(), actual: Num, target: Num, vsTargetPct: Num }).nullable(),
});
export type OverviewAttentionItem = z.infer<typeof OverviewAttentionItem>;

export const OverviewAttention = z.object({
  /** Every category together, largest money at stake first, one row per budget. */
  all: z.array(OverviewAttentionItem),
  over: z.array(OverviewAttentionItem),
  under: z.array(OverviewAttentionItem),
  noSpend: z.array(OverviewAttentionItem),
  kpi: z.array(OverviewAttentionItem),
  /** How many live budgets are in each category (the lists show the first ten). */
  counts: z.object({ over: z.number().int(), under: z.number().int(), noSpend: z.number().int(), kpi: z.number().int() }),
});
export type OverviewAttention = z.infer<typeof OverviewAttention>;

const Count = z.object({ code: z.string().nullable(), label: z.string().nullable(), count: z.number().int() });

/** Open alerts of one rule (HO-010): how many, on how many budgets, of how many the rule covers, and where. */
export const OverviewRuleAlerts = z.object({
  ruleId: z.string().uuid(),
  ruleName: z.string().nullable(),
  severity: z.string(),
  metric: z.string().nullable(),
  count: z.number().int(),
  budgets: z.number().int(),
  /** Live budgets in the rule's scope; null when not counted (a rule firing on few budgets). */
  covered: z.number().int().nullable(),
  byRow: z.array(Count),
});
export type OverviewRuleAlerts = z.infer<typeof OverviewRuleAlerts>;

export const OverviewResponse = z.object({
  currency: z.string(),
  /**
   * `elapsed`: the share of the period gone by the day the actuals cover (what pace uses);
   * `elapsedToday`: by today; `daysLeft`: calendar days left, today included.
   */
  period: z.object({ preset: z.string(), start: z.string().optional(), end: z.string().optional(), elapsed: z.string().optional(), elapsedToday: z.string().optional(), daysLeft: z.number().int().optional() }).passthrough(),
  asOf: DataAsOfView,
  dataAsOf: z.string(),
  /** The heatmap's total: the live leaves (ADR-016). */
  totals: z.record(z.string(), z.string().nullable()),
  /**
   * UX-008 (ADR-051): the tiles' budget, as Budgets counts it; `assigned` is what the leaves (the
   * heatmap) hold. `runRateNeeded`: what is left over the days left, a division, not a forecast.
   */
  headline: z
    .object({
      basis: z.string(),
      budget: z.string().nullable(),
      actual: z.string().nullable(),
      spentPct: z.string().nullable(),
      paceIndex: z.string().nullable(),
      assigned: z.string().nullable(),
      unassigned: z.string().nullable().optional(),
      assignedPct: z.string().nullable().optional(),
      remaining: z.string().nullable().optional(),
      runRateNeeded: z.string().nullable().optional(),
      projected: z.string().nullable().optional(),
      projectedClosePct: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** The snapshot budgets are compared with: the one asked for, else the latest plan (Phase E). */
  compare: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      kind: z.string(),
      asOf: z.string(),
      explicit: z.boolean(),
      changeAbs: z.string().nullable(),
      changePct: z.string().nullable(),
      counts: z.object({ increased: z.number().int(), decreased: z.number().int(), new: z.number().int(), ended: z.number().int() }),
    })
    .nullable()
    .optional(),
  heatmap: OverviewHeatmap.nullable(),
  attention: OverviewAttention.optional(),
  kpi: z
    .object({
      metric: z.string(),
      direction: z.string().optional(),
      dimension: z.object({ key: z.string(), label: z.string() }),
      rows: z.array(z.object({ code: z.string().nullable(), label: z.string().nullable(), budget: Num, actual: Num, target: Num, vsTargetPct: Num })),
    })
    .nullable(),
  /** Open alerts (OPEN_ALERT_STATUSES) the caller may read: the same count as Home's, by rule and by row. */
  alerts: z.object({
    open: z.number(),
    counts: z.record(z.string(), z.number()),
    byRule: z.array(OverviewRuleAlerts).default([]),
    byRow: z.array(Count).default([]),
  }),
  /** The workspace's open approval requests the caller may read (HO-010). */
  queue: z
    .object({ waiting: z.number().int(), overdue: z.number().int(), oldestDays: z.number().int().nullable(), byRole: z.array(z.object({ role: z.string(), count: z.number().int() })), byKind: z.array(z.object({ kind: z.string(), count: z.number().int() })) })
    .optional(),
  freshness: z.object({
    lastFactDate: z.string().nullable(),
    sources: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), isActive: z.boolean(), lastRun: z.object({ status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), matchCoverage: z.string().nullable() }).nullable() })),
    /** The latest projection load, when there are projections (they come from the warehouse). */
    projections: z.object({ loadedAt: z.string(), source: z.string().nullable() }).nullable().optional(),
  }),
  elapsedMs: z.number(),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;
