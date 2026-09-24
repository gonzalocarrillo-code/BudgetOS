import { z } from "zod";
import { ScopeFilter } from "./permissions.js";

/** Targets and the metric library (spec §10, plan §4.8). Values are decimal strings, never JS numbers. */

const IsoDate = z.string().date();
/** `target_version.value` is NUMERIC(18,4): a CPA of 18.25 or a CTR of 0.0125. */
export const TargetValue = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/, "Target value is a decimal string with at most 4 decimals");
const MetricKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower_snake_case metric key");
/** A metric source: spend facts, the approved budget, or a kpi_fact metric. */
const MetricSource = z.string().regex(/^(spend|budget|kpi:[a-z][a-z0-9_]{0,62})$/, "spend, budget or kpi:<metric>");

export const TargetComparator = z.enum(["lte", "gte", "eq", "between"]);

/** POST /workspaces/:ws/metrics (org-level library; org admin only). */
export const CreateMetricInput = z.object({
  key: MetricKey,
  label: z.string().min(1).max(100),
  numerator: MetricSource,
  denominator: MetricSource.nullable().default(null),
  multiplier: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).default("1"),
  direction: z.enum(["lower_is_better", "higher_is_better"]),
  format: z.enum(["currency", "number", "percent", "ratio"]),
  unit: z.string().max(20).optional(),
});
export type CreateMetricInput = z.infer<typeof CreateMetricInput>;

const TargetValueFields = {
  value: TargetValue,
  comparator: TargetComparator.default("lte"),
  valueUpper: TargetValue.optional(),
  rationale: z.string().max(4000).optional(),
};
const between = (v: { comparator: string; valueUpper?: string | undefined }) => (v.comparator === "between") === (v.valueUpper !== undefined);
const betweenMessage = { message: "valueUpper is required for between, and only for between", path: ["valueUpper"] };

export const TargetScope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("envelope"), envelopeId: z.string().uuid() }),
  z.object({ type: z.literal("filter"), filter: ScopeFilter }),
]);
export type TargetScope = z.infer<typeof TargetScope>;

/**
 * POST /workspaces/:ws/targets. Creates the target and its first DRAFT version; submit it to make it
 * current. Envelope targets default to the envelope's dates; filter targets need explicit dates.
 */
export const CreateTargetInput = z
  .object({
    scope: TargetScope,
    metricKey: MetricKey,
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
    ownerId: z.string().uuid().optional(),
    ...TargetValueFields,
  })
  .refine(between, betweenMessage)
  .refine((v) => v.scope.type === "envelope" || (v.startDate !== undefined && v.endDate !== undefined), {
    message: "Filter targets need startDate and endDate",
    path: ["startDate"],
  })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate after endDate", path: ["endDate"] });
export type CreateTargetInput = z.infer<typeof CreateTargetInput>;

/** PATCH /targets/:id/draft. A stale basedOnVersionId is a 409 with currentVersionId. */
export const CreateTargetDraftInput = z
  .object({ basedOnVersionId: z.string().uuid().nullable(), ...TargetValueFields })
  .refine(between, betweenMessage);
export type CreateTargetDraftInput = z.infer<typeof CreateTargetDraftInput>;

/** GET /workspaces/:ws/targets query string. */
export const ListTargetsQuery = z.object({
  metric: MetricKey.optional(),
  envelopeId: z.string().uuid().optional(),
  scopeType: z.enum(["envelope", "filter"]).optional(),
});
export type ListTargetsQuery = z.infer<typeof ListTargetsQuery>;
