import { z } from "zod";

export const Comparator = z.enum([
  "eq",
  "neq",
  "in",
  "nin",
  "contains",
  "starts_with",
  "is_empty",
  "not_empty",
  "between",
  "gt",
  "gte",
  "lt",
  "lte",
  "descends_from",
  "within",
]);
export type Comparator = z.infer<typeof Comparator>;

export const MeasureKey = z.enum([
  "budget",
  /** The part of the budget that falls in the query period (prorated by days of overlap): what pace compares spend with. */
  "budget_in_period",
  "actual",
  "projected",
  "remaining",
  "variance_abs",
  "variance_pct",
  "pace_index",
  "projected_close_pct",
  "spend_to_date_pct",
  /** Phase E (H-004, ADR-053): with `compareTo`, the budget then, and how it changed since (derived, never stored). */
  "budget_baseline",
  "budget_change_abs",
  "budget_change_pct",
  /**
   * HO-009 (ADR-064): money ahead of plan, `actual − budget_in_period × elapsed` (negative: behind).
   * Pace in currency, so the largest gaps rank first whatever the budget's size. Derived, never stored.
   */
  "ahead_of_plan_abs",
]);
/** The measures that need `QueryRequest.compareTo`. */
export const COMPARE_MEASURES: ReadonlySet<string> = new Set(["budget_baseline", "budget_change_abs", "budget_change_pct"]);
export type MeasureKey = z.infer<typeof MeasureKey>;

export const AttrKey = z.enum([
  "status",
  "owner_id",
  "approver_id",
  "requested_by",
  "tag",
  "currency",
  "source_system",
  "has_open_thread",
  "mentions_user",
  "commented_by",
  "created_at",
  "updated_at",
  "start_date",
  "end_date",
  "name",
  "has_attachments",
  "alert_severity",
  "is_leaf",
  /** HO-010: ended early (ADR-053): eq true or false. An ended budget keeps its APPROVED status. */
  "is_ended",
  /** The envelope's parent (ADR-050): eq / in an envelope id, or is_empty for top-level budgets. */
  "parent_id",
  /** T-8 (audit): the envelope's own id, eq or in a set — callers who already resolved ids (search hits) read them back through the one query path instead of re-deriving numbers. */
  "id",
  /** T-038: linked to an experiment. Value: a status (RUNNING), an experiment id, or `<id>:TEST` / `<id>:CONTROL`. */
  "experiment",
]);

export const FieldRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dimension"), key: z.string().min(1) }),
  z.object({ kind: z.literal("measure"), key: MeasureKey }),
  z.object({
    kind: z.literal("target"),
    metric: z.string().min(1),
    field: z.enum(["value", "actual", "vs_target_pct", "exists"]),
  }),
  z.object({ kind: z.literal("attr"), key: AttrKey }),
]);
export type FieldRef = z.infer<typeof FieldRef>;

/** Relative date spec for `within`: { unit, amount, anchor } e.g. last 30 days = { unit:'day', amount:-30 } */
export const RelativeDate = z.object({
  unit: z.enum(["day", "week", "month", "quarter", "year"]),
  amount: z.number().int(),
  anchor: z.enum(["today", "period_start", "period_end"]).default("today"),
});

export const Predicate = z.object({
  field: FieldRef,
  op: Comparator,
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
      z.tuple([z.union([z.string(), z.number()]), z.union([z.string(), z.number()])]),
      RelativeDate,
      z.null(),
    ])
    .optional(),
});
export type Predicate = z.infer<typeof Predicate>;

export interface FilterGroupT {
  logic: "and" | "or";
  not?: boolean | undefined;
  children: Array<Predicate | FilterGroupT>;
}
export const FilterGroup = z.lazy(() =>
  z.object({
    logic: z.enum(["and", "or"]),
    not: z.boolean().optional(),
    children: z.array(z.union([Predicate, FilterGroup])).max(200),
  }),
) as unknown as z.ZodType<FilterGroupT>;

export const emptyFilter: FilterGroupT = { logic: "and", children: [] };
export const isPredicate = (n: Predicate | FilterGroupT): n is Predicate => "field" in n;

/**
 * Live leaves (ADR-016): envelopes with no non-archived child that are not archived themselves.
 * Totals, trees and pivots sum these; a parent is a cap over its children and never counts twice.
 */
export const LIVE_LEAVES: Predicate[] = [
  { field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true },
  { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" },
];

/**
 * Top-level budgets (ADR-050, ADR-051): live envelopes with no parent. Queried with `subtree: true`
 * each reads its own approved amount against everything spent under it. This is what "the budget"
 * means on Budgets, Home and the Overview headline, for callers who read the whole workspace.
 */
export const TOP_LEVEL: Predicate[] = [
  { field: { kind: "attr", key: "parent_id" }, op: "is_empty" },
  { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" },
];
