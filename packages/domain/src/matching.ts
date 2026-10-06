import { z } from "zod";

/**
 * EX-1 (ADR-0085): one-to-one fact → budget matching. A match rule sends every fact whose
 * dimension_values satisfy its predicate to one envelope. Order: a manual pin, then match rules,
 * then the tuple (most specific envelope whose tuple is a subset of the fact's). When more than one
 * envelope qualifies at the deciding level the fact is `ambiguous`: no envelope, its candidates
 * listed, never an arbitrary pick.
 */

const IsoDate = z.string().date();
const Money = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Money is a decimal string");

/** The comparators a match rule may use over fact dimensions (the database's match_rule_matches). */
export const MatchRuleOp = z.enum(["eq", "neq", "in", "nin", "contains", "starts_with", "is_empty", "not_empty"]);
export type MatchRuleOp = z.infer<typeof MatchRuleOp>;

export const MatchRuleCondition = z
  .object({
    field: z.object({ kind: z.literal("dimension"), key: z.string().min(1).max(120) }).strict(),
    op: MatchRuleOp,
    value: z.union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).min(1).max(1000)]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const list = c.op === "in" || c.op === "nin";
    const none = c.op === "is_empty" || c.op === "not_empty";
    if (none && c.value !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${c.op} takes no value`, path: ["value"] });
    if (!none && list && !Array.isArray(c.value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${c.op} takes a list of values`, path: ["value"] });
    if (!none && !list && typeof c.value !== "string") ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${c.op} takes one value`, path: ["value"] });
  });
export type MatchRuleCondition = z.infer<typeof MatchRuleCondition>;

export interface MatchRuleGroupT {
  logic: "and" | "or";
  not?: boolean | undefined;
  children: Array<MatchRuleCondition | MatchRuleGroupT>;
}
const MatchRuleGroup: z.ZodType<MatchRuleGroupT> = z.lazy(() =>
  z
    .object({
      logic: z.enum(["and", "or"]),
      not: z.boolean().optional(),
      children: z.array(z.union([MatchRuleCondition, MatchRuleGroup])).min(1).max(50),
    })
    .strict(),
);

/** A FilterGroup over fact dimension_values (a subset of the FilterGroup AST). Never empty: an empty rule would take every fact. */
export const MatchRulePredicate = MatchRuleGroup;
export type MatchRulePredicate = MatchRuleGroupT;

/** The common rule: dimension `key` equals `value` (the "Assign to budget" action uses `campaign`). */
export const equalsPredicate = (key: string, value: string): MatchRulePredicate => ({ logic: "and", children: [{ field: { kind: "dimension", key }, op: "eq", value }] });

/** POST /workspaces/:ws/match-rules. */
export const CreateMatchRuleInput = z
  .object({
    envelopeId: z.string().uuid(),
    predicate: MatchRulePredicate,
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
  })
  .strict()
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate is after endDate", path: ["endDate"] });
export type CreateMatchRuleInput = z.infer<typeof CreateMatchRuleInput>;

export const MatchRuleView = z.object({
  id: z.string().uuid(),
  envelopeId: z.string().uuid(),
  envelopeName: z.string(),
  predicate: MatchRulePredicate,
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
});
export type MatchRuleView = z.infer<typeof MatchRuleView>;

export const MatchRulesResponse = z.object({ rules: z.array(MatchRuleView) });
export type MatchRulesResponse = z.infer<typeof MatchRulesResponse>;

/** What a re-match changed: facts per table whose envelope or status moved, and the envelopes to refresh. */
export const RematchResult = z.object({
  spend: z.number().int(),
  kpi: z.number().int(),
  projection: z.number().int(),
  envelopeIds: z.array(z.string().uuid()),
});
export type RematchResult = z.infer<typeof RematchResult>;

export const MatchRuleWriteResponse = z.object({ rule: MatchRuleView, rematch: RematchResult });
export type MatchRuleWriteResponse = z.infer<typeof MatchRuleWriteResponse>;

/** GET /workspaces/:ws/match-coverage?from&to (both optional, yyyy-MM-dd, inclusive). */
export const MatchCoverageQuery = z
  .object({ from: IsoDate.optional(), to: IsoDate.optional(), limit: z.coerce.number().int().min(1).max(1000).optional() })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, { message: "from is after to", path: ["to"] });
export type MatchCoverageQuery = z.infer<typeof MatchCoverageQuery>;

export const CoverageAmounts = z.object({
  /** Reporting currency, Decimal strings. matched + unmatched + ambiguous = total. */
  total: Money,
  matched: Money,
  unmatched: Money,
  ambiguous: Money,
  totalRows: z.number().int(),
  matchedRows: z.number().int(),
  unmatchedRows: z.number().int(),
  ambiguousRows: z.number().int(),
});
export type CoverageAmounts = z.infer<typeof CoverageAmounts>;

export const MatchCandidate = z.object({ id: z.string().uuid(), name: z.string() });

export const OpenCampaign = z.object({
  /** The fact's `campaign` dimension value; null for facts without one. */
  campaign: z.string().nullable(),
  label: z.string().nullable(),
  status: z.enum(["unmatched", "ambiguous"]),
  amount: Money,
  rows: z.number().int(),
  firstDate: IsoDate,
  lastDate: IsoDate,
  /** For ambiguous facts: the envelopes that tied. */
  candidates: z.array(MatchCandidate),
});
export type OpenCampaign = z.infer<typeof OpenCampaign>;

export const MatchCoverageResponse = z.object({
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  currency: z.string(),
  totals: CoverageAmounts,
  bySource: z.array(CoverageAmounts.extend({ sourceId: z.string().uuid().nullable(), sourceName: z.string().nullable(), sourceSystem: z.string() })),
  byCampaign: z.array(CoverageAmounts.extend({ campaign: z.string().nullable(), label: z.string().nullable() })),
  /** Unmatched and ambiguous spend by campaign, largest first. */
  open: z.array(OpenCampaign),
});
export type MatchCoverageResponse = z.infer<typeof MatchCoverageResponse>;

/** The dimension key campaigns live under on facts (EX-1..EX-3 shared contract). */
export const CAMPAIGN_DIMENSION = "campaign";
