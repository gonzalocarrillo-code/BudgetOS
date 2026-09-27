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
  templateId: z.string().uuid().optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(["asc", "desc"]) })).max(3).default([]),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryRow = z.object({
  key: z.string(),
  envelopeId: z.string().uuid().nullable(),
  /** Flat rows: the version an edit is based on (draft, else current), for optimistic concurrency. */
  versionId: z.string().uuid().nullable().optional(),
  depth: z.number().int().optional(),
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
  measures: z.array(MeasureKey).min(1).default(["budget", "actual", "projected", "pace_index"]),
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
