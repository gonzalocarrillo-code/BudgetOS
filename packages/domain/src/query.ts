import { z } from "zod";
import { FilterGroup, MeasureKey } from "./filter-ast.js";

export const PeriodSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fiscal"), key: z.string() }),
  z.object({ kind: z.literal("range"), start: z.string().date(), end: z.string().date() }),
  z.object({
    kind: z.literal("relative"),
    preset: z.enum([
      "current_month",
      "current_quarter",
      "current_year",
      "last_30_days",
      "last_90_days",
      "ytd",
      "next_90_days",
    ]),
  }),
]);
export type PeriodSpec = z.infer<typeof PeriodSpec>;
export const Grain = z.enum(["total", "day", "week", "month", "quarter"]);

export const QueryRequest = z.object({
  workspaceId: z.string().uuid(),
  filter: FilterGroup.optional(),
  groupBy: z.array(z.string()).max(8).default([]),
  measures: z.array(MeasureKey).min(1).default(["budget", "actual", "projected", "pace_index"]),
  targets: z.array(z.string()).default([]),
  period: PeriodSpec,
  grain: Grain.default("total"),
  asOf: z.string().datetime().optional(),
  /**
   * Phase E (H-004, ADR-053): what `budget_baseline` and the change measures compare with: a saved
   * snapshot's frozen amounts, or the budgets approved at an instant. A budget the snapshot does
   * not hold has no baseline, and its change is its whole budget (a new budget).
   */
  compareTo: z.union([z.object({ baselineId: z.string().uuid() }).strict(), z.object({ asOf: z.string().datetime() }).strict()]).optional(),
  templateId: z.string().uuid().optional(),
  /**
   * Budget structure (ADR-050): each flat row's actual and projected include every envelope under
   * it (parent links), so a parent reads against its own amount; rows carry `childCount`.
   */
  subtree: z.boolean().optional(),
  /**
   * ADR-059: every live budget counts for what it holds itself: its amount less its live children's
   * in the period (a leaf holds all of it), plus its own spend. Groups and totals then add up to the
   * top-level budgets however they group, and each flat row carries `childCount`. Not with `subtree`.
   */
  unallocated: z.boolean().optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(["asc", "desc"]) })).max(3).default([]),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  /**
   * T-5 (audit): demo envelopes and demo facts (spec §27) are excluded once the workspace has a
   * real (non-demo, live) budget, so it never mixes demo money into its totals; a pure-demo
   * workspace (onboarding, before the first real budget) shows them automatically, with no caller
   * plumbing needed. `true` forces them in unconditionally regardless of real budgets.
   */
  includeDemo: z.boolean().default(false),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryRow = z.object({
  key: z.string(),
  envelopeId: z.string().uuid().nullable(),
  /** Flat rows: the version an edit is based on (draft, else current), for optimistic concurrency. */
  versionId: z.string().uuid().nullable().optional(),
  depth: z.number().int().optional(),
  /**
   * Group rows: the envelope that *is* this group (its dimension tuple is exactly the group's), so
   * a parent opens in the drawer like a leaf. Null when no single envelope is the group.
   */
  nodeEnvelopeId: z.string().uuid().nullable().optional(),
  /** Flat rows: the budget's start and end dates (ADR-060). */
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  /** Flat rows with `subtree` or `unallocated`: live children of this envelope; its parent. */
  childCount: z.number().int().optional(),
  parentId: z.string().uuid().nullable().optional(),
  path: z.array(z.string()),
  dimensions: z.record(z.string(), z.string().nullable()),
  measures: z.record(z.string(), z.string().nullable()),
  targets: z
    .record(
      z.string(),
      z.object({
        target: z.string().nullable(),
        actual: z.string().nullable(),
        vsTargetPct: z.string().nullable(),
      }),
    )
    .default({}),
  /** Flat rows: the envelope's status; an ended budget (H-011) reads ENDED, though it stays APPROVED underneath. */
  status: z.string().nullable(),
  pendingCount: z.number().int().default(0),
  openAlerts: z.number().int().default(0),
  openThreads: z.number().int().default(0),
});
export type QueryRow = z.infer<typeof QueryRow>;
export const QueryResponse = z.object({
  rows: z.array(QueryRow),
  nextCursor: z.string().nullable(),
  totals: z.record(z.string(), z.string().nullable()),
  dataAsOf: z.string().datetime(),
  dataVersion: z.number().int(),
  /** Where the rows came from (ADR-042): Postgres, the warehouse replica, or the query cache. */
  engine: z.enum(["postgres", "warehouse", "cache"]).optional(),
  elapsedMs: z.number(),
});
export type QueryResponse = z.infer<typeof QueryResponse>;

/**
 * POST /workspaces/:ws/tree (ADR-038): one level of a hierarchy template's tree from rollup_cache
 * (plan §5.3, "roll-ups are not computed on read"). No filter and no as-of: those trees go through
 * /query. `parentPath` '' (or omitted) is the first level; a node's path joins its segments with '/'.
 */
export const TreeRequest = z.object({
  workspaceId: z.string().uuid(),
  templateId: z.string().uuid(),
  period: PeriodSpec,
  parentPath: z.string().max(4000).default(""),
  // The roll-up cache holds no snapshot: comparing goes through /query with compareTo (H-004).
  // Ahead of plan (ADR-064) is computed by /query only, like the compare measures.
  measures: z.array(MeasureKey.exclude(["budget_baseline", "budget_change_abs", "budget_change_pct", "ahead_of_plan_abs"])).min(1).default(["budget", "actual", "projected", "pace_index"]),
});
export type TreeRequest = z.infer<typeof TreeRequest>;

export const TreeResponse = z.object({
  /** false: not served from the cache (`reason`); the caller asks /query instead. */
  available: z.boolean(),
  reason: z.enum(["scoped", "not_cached"]).nullable(),
  /** The children of `parentPath`, in the shape /query returns for groups. */
  rows: z.array(QueryRow),
  /** The root node: the tree's totals. */
  totals: z.record(z.string(), z.string().nullable()),
  dataAsOf: z.string().datetime(),
  /** The workspace's data version, and the oldest version any returned node was computed at. */
  dataVersion: z.number().int(),
  cacheVersion: z.number().int().nullable(),
  elapsedMs: z.number(),
});
export type TreeResponse = z.infer<typeof TreeResponse>;
