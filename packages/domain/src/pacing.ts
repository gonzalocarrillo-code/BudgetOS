import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";
import { PeriodSpec } from "./query.js";

/** Pacing rules and alerts (spec §11, plan §8.4). Thresholds are decimal strings. */

export const RuleMetric = z.enum([
  "pace_index",
  "projected_close_pct",
  "spend_to_date_pct",
  "projected_variance_abs",
  "kpi_vs_target_pct",
  "implied_volume_gap",
  "efficiency_adjusted_pace",
]);
export type RuleMetric = z.infer<typeof RuleMetric>;

export const RuleComparator = z.enum(["gt", "gte", "lt", "lte"]);
export const RuleSeverity = z.enum(["info", "warning", "critical", "data"]);
const Threshold = z.string().regex(/^-?\d{1,13}(\.\d{1,4})?$/, "decimal string, at most 4 decimals");

/**
 * Metric arguments. `metricKey` names the KPI for kpi_vs_target_pct; `period` is the query period
 * (default: the current fiscal year, the span budgets are set for); `daysRemainingLt` limits the rule
 * to envelopes ending within that many days ("projected close < 85% with < 30 days left").
 */
export const RuleMetricArgs = z
  .object({
    metricKey: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
    period: PeriodSpec.optional(),
    daysRemainingLt: z.number().int().min(1).max(3660).optional(),
  })
  .strict();
export type RuleMetricArgs = z.infer<typeof RuleMetricArgs>;

export const RuleDelivery = z
  .object({ inApp: z.boolean().default(true), slackChannel: z.string().min(1).max(80).optional(), emails: z.array(z.string().email()).max(20).optional() })
  .strict();

const ruleFields = {
  name: z.string().min(1).max(200),
  scope: FilterGroup.optional(),
  metric: RuleMetric,
  metricArgs: RuleMetricArgs.default({}),
  comparator: RuleComparator,
  threshold: Threshold,
  consecutiveDays: z.number().int().min(1).max(90).default(1),
  severity: RuleSeverity,
  delivery: RuleDelivery.default({ inApp: true }),
};

const needsMetricKey = (r: { metric?: string | undefined; metricArgs?: { metricKey?: string | undefined } | undefined }) =>
  r.metric !== "kpi_vs_target_pct" || r.metricArgs?.metricKey !== undefined;

/** POST /workspaces/:ws/rules. */
export const CreateRuleInput = z.object(ruleFields).refine(needsMetricKey, { message: "kpi_vs_target_pct needs metricArgs.metricKey", path: ["metricArgs"] });
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;

/** PATCH /rules/:id. The metric and its arguments change together. */
export const UpdateRuleInput = z
  .object({
    name: ruleFields.name.optional(),
    scope: FilterGroup.optional(),
    metric: RuleMetric.optional(),
    metricArgs: RuleMetricArgs.optional(),
    comparator: RuleComparator.optional(),
    threshold: Threshold.optional(),
    consecutiveDays: z.number().int().min(1).max(90).optional(),
    severity: RuleSeverity.optional(),
    delivery: RuleDelivery.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine((v) => v.metric === undefined || v.metricArgs !== undefined, { message: "Changing the metric needs its metricArgs", path: ["metricArgs"] })
  .refine(needsMetricKey, { message: "kpi_vs_target_pct needs metricArgs.metricKey", path: ["metricArgs"] });
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

/** PATCH /alerts/:id (spec §11): acknowledge, snooze until a time, or resolve; optionally reassign. */
export const UpdateAlertInput = z
  .object({
    status: z.enum(["ACKNOWLEDGED", "SNOOZED", "RESOLVED"]).optional(),
    snoozedUntil: z.string().datetime().optional(),
    ownerId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.ownerId !== undefined, "Set a status or an owner")
  .refine((v) => (v.status === "SNOOZED") === (v.snoozedUntil !== undefined), { message: "snoozedUntil is required to snooze, and only then", path: ["snoozedUntil"] });
export type UpdateAlertInput = z.infer<typeof UpdateAlertInput>;

/** GET /alerts?status&severity&ruleId&envelopeId&filter (filter is a FilterGroup as JSON). */
export const ListAlertsQuery = z.object({
  status: z.string().regex(/^(OPEN|ACKNOWLEDGED|SNOOZED|RESOLVED)(,(OPEN|ACKNOWLEDGED|SNOOZED|RESOLVED))*$/).optional(),
  severity: RuleSeverity.optional(),
  ruleId: z.string().uuid().optional(),
  envelopeId: z.string().uuid().optional(),
  filter: z.string().max(20_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListAlertsQuery = z.infer<typeof ListAlertsQuery>;
