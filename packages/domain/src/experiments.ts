import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";

/**
 * Experiments (spec §25, plan §4.12): a test budget with a question attached. Test envelopes are
 * ordinary envelopes linked to it (and tagged `experiment`); the read-out compares the test scope
 * with the control scope through the planner. Values are decimal strings, never JS numbers.
 */

const IsoDate = z.string().date();
const MetricKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower_snake_case metric key");

export const ExperimentKind = z.enum(["PLATFORM_TEST", "OBJECTIVE_TEST", "AUDIENCE_TEST", "CREATIVE_TEST", "GEO_HOLDOUT", "CUSTOM"]);
export type ExperimentKind = z.infer<typeof ExperimentKind>;
export const ExperimentStatus = z.enum(["PLANNED", "RUNNING", "EVALUATING", "CONCLUDED", "ABANDONED"]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;
export const ExperimentRole = z.enum(["TEST", "CONTROL"]);
export type ExperimentRole = z.infer<typeof ExperimentRole>;

/**
 * Success criterion: the test's primary metric `comparator` the control's (vs control), or a fixed
 * value (absolute). `minDays`: no verdict before the experiment has run that many days.
 */
export const SuccessCriterion = z
  .object({
    comparator: z.enum(["lte", "gte"]),
    vs: z.enum(["control", "absolute"]),
    value: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    minDays: z.number().int().min(0).max(3650).optional(),
  })
  .refine((c) => (c.vs === "absolute") === (c.value !== undefined), { message: "value is required for an absolute criterion, and only for it", path: ["value"] });
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

const Fields = {
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().min(1).max(4000),
  kind: ExperimentKind,
  testFilter: FilterGroup,
  controlFilter: FilterGroup.nullable(),
  primaryMetric: MetricKey,
  criterion: SuccessCriterion,
  startDate: IsoDate,
  endDate: IsoDate,
  ownerId: z.string().uuid(),
};

/** POST /workspaces/:ws/experiments. The owner defaults to the caller; a control scope is optional. */
export const CreateExperimentInput = z
  .object({ ...Fields, controlFilter: Fields.controlFilter.default(null), ownerId: Fields.ownerId.optional() })
  .refine((v) => v.startDate <= v.endDate, { message: "startDate after endDate", path: ["endDate"] })
  .refine((v) => v.criterion.vs === "absolute" || v.controlFilter !== null, { message: "A vs-control criterion needs a control scope", path: ["controlFilter"] });
export type CreateExperimentInput = z.infer<typeof CreateExperimentInput>;

/** PATCH /experiments/:id: any field while PLANNED or RUNNING; nothing once concluded or abandoned. */
export const UpdateExperimentInput = z
  .object(Object.fromEntries(Object.entries(Fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof Fields]: z.ZodOptional<(typeof Fields)[K]> })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type UpdateExperimentInput = z.infer<typeof UpdateExperimentInput>;

/** POST /experiments/:id/link */
export const LinkEnvelopeInput = z.object({ envelopeId: z.string().uuid(), role: ExperimentRole });
export type LinkEnvelopeInput = z.infer<typeof LinkEnvelopeInput>;

/** POST /experiments/:id/conclude: the decision becomes a comment on every linked envelope. */
export const ConcludeExperimentInput = z.object({ decision: z.string().trim().min(20, "A decision needs at least 20 characters").max(4000) });
export type ConcludeExperimentInput = z.infer<typeof ConcludeExperimentInput>;

/** GET /workspaces/:ws/experiments?status= (comma-separated). */
export const ListExperimentsQuery = z.object({
  status: z.string().regex(/^(PLANNED|RUNNING|EVALUATING|CONCLUDED|ABANDONED)(,(PLANNED|RUNNING|EVALUATING|CONCLUDED|ABANDONED))*$/).optional(),
});
export type ListExperimentsQuery = z.infer<typeof ListExperimentsQuery>;

/** Planner totals over one scope for the experiment's window (spec §25.2). */
export const MetricSet = z.object({
  budget: z.string().nullable(),
  actual: z.string().nullable(),
  /** The primary metric over the scope, weighted: Σnumerator / Σdenominator (CPA = Σspend / Σconversions). */
  metric: z.string().nullable(),
  leafCount: z.number().int(),
});
export type MetricSet = z.infer<typeof MetricSet>;

export const ExperimentReadout = z.object({
  test: MetricSet,
  control: MetricSet.nullable(),
  /** test − control (or − the absolute value) and that as a share of it; null when either side has no metric. */
  delta: z.object({ abs: z.string(), pct: z.string().nullable() }).nullable(),
  /** null until the experiment has run `minDays` (and while either side has no metric). */
  criterionMet: z.boolean().nullable(),
  daysRunning: z.number().int(),
});
export type ExperimentReadout = z.infer<typeof ExperimentReadout>;

/** Allowed status moves (spec §25.3). CONCLUDED and ABANDONED are final. */
export const EXPERIMENT_TRANSITIONS: Record<"start" | "evaluate" | "abandon" | "conclude", { from: ExperimentStatus[]; to: ExperimentStatus }> = {
  start: { from: ["PLANNED"], to: "RUNNING" },
  evaluate: { from: ["RUNNING"], to: "EVALUATING" },
  abandon: { from: ["PLANNED", "RUNNING", "EVALUATING"], to: "ABANDONED" },
  conclude: { from: ["RUNNING", "EVALUATING"], to: "CONCLUDED" },
};

/**
 * Whether the criterion is met: `null` before `minDays` have run or while a side has no metric.
 * Decimal strings are compared exactly (no floats).
 */
export function criterionMet(c: SuccessCriterion, test: string | null, reference: string | null, daysRunning: number, compare: (a: string, b: string) => number): boolean | null {
  if (daysRunning < (c.minDays ?? 0)) return null;
  if (test === null || reference === null) return null;
  const cmp = compare(test, reference);
  return c.comparator === "lte" ? cmp <= 0 : cmp >= 0;
}
