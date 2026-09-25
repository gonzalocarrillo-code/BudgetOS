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
  "actual",
  "projected",
  "remaining",
  "variance_abs",
  "variance_pct",
  "pace_index",
  "projected_close_pct",
  "spend_to_date_pct",
]);
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
