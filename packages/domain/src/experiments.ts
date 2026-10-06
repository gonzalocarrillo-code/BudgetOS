import { z } from "zod";
import { FilterGroup, isPredicate, type FilterGroupT } from "./filter-ast.js";

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
 * EX-2 (ADR-086): what a side's filter is evaluated on. `envelope` (the default, spec §25): the
 * budgets the filter selects, plus the envelopes linked in that role. `fact`: the spend / KPI facts
 * whose own `dimension_values` match (e.g. `campaign = A`), independent of budgets.
 */
export const ExperimentScopeKind = z.enum(["envelope", "fact"]);
export type ExperimentScopeKind = z.infer<typeof ExperimentScopeKind>;

const FACT_OPS = new Set(["eq", "neq", "in", "nin", "is_empty", "not_empty", "contains", "starts_with"]);
/** A fact scope filters on fact dimensions only (no measures, targets or envelope attributes). */
export function isFactScope(g: FilterGroupT): boolean {
  return g.children.every((c) => (isPredicate(c) ? c.field.kind === "dimension" && FACT_OPS.has(c.op) : isFactScope(c)));
}
const factSideOk = (kind: ExperimentScopeKind | undefined, filter: FilterGroupT | null | undefined) => kind !== "fact" || (filter !== null && filter !== undefined && filter.children.length > 0 && isFactScope(filter));
const FACT_SIDE_MESSAGE = "A fact-scoped side needs at least one dimension predicate (eq, neq, in, nin, is_empty, not_empty, contains, starts_with)";

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
  testScopeKind: ExperimentScopeKind,
  controlScopeKind: ExperimentScopeKind,
};

/** POST /workspaces/:ws/experiments. The owner defaults to the caller; a control scope is optional. */
export const CreateExperimentInput = z
  .object({ ...Fields, controlFilter: Fields.controlFilter.default(null), ownerId: Fields.ownerId.optional(), testScopeKind: ExperimentScopeKind.default("envelope"), controlScopeKind: ExperimentScopeKind.default("envelope") })
  .refine((v) => v.startDate <= v.endDate, { message: "startDate after endDate", path: ["endDate"] })
  .refine((v) => v.criterion.vs === "absolute" || v.controlFilter !== null, { message: "A vs-control criterion needs a control scope", path: ["controlFilter"] })
  .refine((v) => factSideOk(v.testScopeKind, v.testFilter), { message: FACT_SIDE_MESSAGE, path: ["testFilter"] })
  .refine((v) => v.controlFilter === null || factSideOk(v.controlScopeKind, v.controlFilter), { message: FACT_SIDE_MESSAGE, path: ["controlFilter"] });
export type CreateExperimentInput = z.infer<typeof CreateExperimentInput>;

/**
 * PATCH /experiments/:id: any field while PLANNED, RUNNING or EVALUATING. EX-2: the dates stay
 * editable in every status (any start / end, past or future, end ≥ start); a concluded or abandoned
 * experiment takes nothing else. The fact-side checks on the merged experiment are the command's.
 */
export const UpdateExperimentInput = z
  .object(Object.fromEntries(Object.entries(Fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof Fields]: z.ZodOptional<(typeof Fields)[K]> })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate after endDate", path: ["endDate"] });
/** The fields a concluded or abandoned experiment still accepts. */
export const EXPERIMENT_ALWAYS_EDITABLE: ReadonlySet<string> = new Set(["startDate", "endDate"]);
/** Whether a side with this kind and filter is valid (a fact side needs dimension predicates). */
export const experimentSideValid = factSideOk;
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

/** GET /workspaces/:ws/experiments/scope-values: the values of a fact dimension found in spend facts in a window (the campaign picker). */
export const ExperimentScopeValuesQuery = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).default("campaign"),
    start: IsoDate,
    end: IsoDate,
    includeDemo: z.enum(["true", "false"]).optional(),
  })
  .refine((v) => v.start <= v.end, { message: "start after end", path: ["end"] });
export type ExperimentScopeValuesQuery = z.infer<typeof ExperimentScopeValuesQuery>;
export const ExperimentScopeValue = z.object({ code: z.string(), label: z.string().nullable(), spend: z.string().nullable(), days: z.number().int() });
export type ExperimentScopeValue = z.infer<typeof ExperimentScopeValue>;

/**
 * EX-2: one day of a side. `hasData` false (no fact row for the side that day): every value is
 * null — no data, never 0. With data, a value is still null when no fact of that metric exists.
 */
export const ExperimentDay = z.object({
  date: IsoDate,
  hasData: z.boolean(),
  spend: z.string().nullable(),
  /** Σ kpi_fact value per fact metric (conversions, revenue, …). */
  kpis: z.record(z.string().nullable()),
  /** Derived metrics from the metric library (CPA, ROAS, …), that day's Σnumerator / Σdenominator. */
  metrics: z.record(z.string().nullable()),
});
export type ExperimentDay = z.infer<typeof ExperimentDay>;

/** EX-2: one side's facts over [start, min(end, today)]: totals over the days with data, and the days. */
export const ExperimentSide = z.object({
  scopeKind: ExperimentScopeKind,
  totals: z.object({
    spend: z.string().nullable(),
    kpis: z.record(z.string().nullable()),
    /** Weighted over the days with data: Σnumerator / Σdenominator, never an average of daily ratios. */
    metrics: z.record(z.string().nullable()),
    daysWithData: z.number().int(),
    daysInWindow: z.number().int(),
  }),
  days: z.array(ExperimentDay),
});
export type ExperimentSide = z.infer<typeof ExperimentSide>;

export const ExperimentSides = z.object({ test: ExperimentSide, control: ExperimentSide.nullable() });
export type ExperimentSides = z.infer<typeof ExperimentSides>;

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
