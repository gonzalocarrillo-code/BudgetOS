import { z } from "zod";

/**
 * EX-1 (ADR-0085): one-to-one fact → budget matching. A match rule sends every fact whose
 * dimension_values satisfy its predicate to one envelope. Order: a manual pin, then match rules,
 * then the tuple (most specific envelope whose tuple is a subset of the fact's). When more than one
 * envelope qualifies at the deciding level the fact is `ambiguous`: no envelope, its candidates
 * listed, never an arbitrary pick.
 */

/** The dimension key campaigns live under on facts (EX-1..EX-3 shared contract). */
export const CAMPAIGN_DIMENSION = "campaign";

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

/**
 * EX-5 (ADR-0090): why a fact stays unassigned besides "nothing qualified": its campaign name does
 * not fit the workspace's naming conventions, or the budget its source row names is unknown, or does
 * not cover the fact's date. Stored in the fact's match_status (with `ambiguous`).
 */
export const UnassignedReason = z.enum(["name_mismatch", "unknown_budget_ref", "budget_ref_outside_dates"]);
export type UnassignedReason = z.infer<typeof UnassignedReason>;

/** The characters a campaign name may be split on. */
export const NamingConventionDelimiter = z.enum(["_", "-", ".", "|", "/", ":", "·", " ", "+"]);
export type NamingConventionDelimiter = z.infer<typeof NamingConventionDelimiter>;

const DimensionKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "a dimension key");

/** One position of a campaign name: the dimension it names (null = ignored) and raw value → value code aliases. */
export const NamingConventionToken = z
  .object({
    dimension: DimensionKey.nullable(),
    aliases: z.record(z.string().min(1).max(100), z.string().min(1).max(200)).default({}),
  })
  .strict();
export type NamingConventionToken = z.infer<typeof NamingConventionToken>;

/** POST /workspaces/:ws/naming-conventions: `BR_Meta_Prospecting_Q4_VideoA` split on `_` → country, platform, objective, ignore, ignore. */
export const CreateNamingConventionInput = z
  .object({ delimiter: NamingConventionDelimiter, tokens: z.array(NamingConventionToken).min(1).max(20) })
  .strict()
  .superRefine((v, ctx) => {
    const dims = v.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension]));
    if (dims.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Name at least one position's dimension", path: ["tokens"] });
    if (new Set(dims).size !== dims.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each dimension may come from one position only", path: ["tokens"] });
    if (dims.includes(CAMPAIGN_DIMENSION)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The campaign itself is what is parsed", path: ["tokens"] });
    v.tokens.forEach((t, i) => {
      if (t.dimension === null && Object.keys(t.aliases).length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An ignored position has no aliases", path: ["tokens", i, "aliases"] });
    });
  });
export type CreateNamingConventionInput = z.infer<typeof CreateNamingConventionInput>;

export const NamingConventionView = z.object({
  id: z.string().uuid(),
  delimiter: NamingConventionDelimiter,
  tokens: z.array(NamingConventionToken),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
});
export type NamingConventionView = z.infer<typeof NamingConventionView>;

/** A source mapping column with role `budget_ref`: the source row names its budget (id or match key). */
export const BudgetReferenceView = z.object({ sourceId: z.string().uuid(), sourceName: z.string(), column: z.string() });
export type BudgetReferenceView = z.infer<typeof BudgetReferenceView>;

/** GET /workspaces/:ws/match-rules: the three kinds of mapping rule (ADR-0090). */
export const MatchRulesResponse = z.object({
  rules: z.array(MatchRuleView),
  conventions: z.array(NamingConventionView).default([]),
  references: z.array(BudgetReferenceView).default([]),
});
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

export const NamingConventionWriteResponse = z.object({ convention: NamingConventionView, rematch: RematchResult });
export type NamingConventionWriteResponse = z.infer<typeof NamingConventionWriteResponse>;

/** POST /workspaces/:ws/naming-conventions/preview: a convention (saved or not) over campaign names (the largest real ones when none are given). */
export const NamingConventionPreviewInput = z.object({ convention: CreateNamingConventionInput, names: z.array(z.string().min(1).max(500)).max(20).optional() }).strict();
export type NamingConventionPreviewInput = z.infer<typeof NamingConventionPreviewInput>;

/** Why a name does not fit a convention: wrong number of parts, an empty part, or a part that is no known value of its dimension. */
export const ConventionProblem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parts"), expected: z.number().int(), found: z.number().int() }),
  z.object({ kind: z.literal("empty"), position: z.number().int() }),
  z.object({ kind: z.literal("unknown_value"), position: z.number().int(), dimension: z.string(), value: z.string() }),
]);
export type ConventionProblem = z.infer<typeof ConventionProblem>;

export const NamingConventionPreviewResponse = z.object({
  samples: z.array(
    z.object({
      name: z.string(),
      /** The campaign value (code) the name belongs to; null for a name typed in. */
      campaign: z.string().nullable(),
      dimensionValues: z.record(z.string(), z.string()).nullable(),
      problem: ConventionProblem.nullable(),
    }),
  ),
});
export type NamingConventionPreviewResponse = z.infer<typeof NamingConventionPreviewResponse>;

export type ConventionParse = { ok: true; dimensionValues: Record<string, string> } | { ok: false; problem: ConventionProblem };

/**
 * EX-5 (ADR-0090): a campaign name read with a naming convention. The name is split on the
 * delimiter and must have exactly one part per position; each named position's part goes through
 * the position's aliases (case-insensitive) and then `resolve` (the registry: a value code, matched
 * case-insensitively or by the value's own aliases), which returns null for an unknown value.
 * Ignored positions only need to be there. The same function backs matching and the preview.
 */
export function parseCampaignName(
  convention: { delimiter: string; tokens: ReadonlyArray<{ dimension: string | null; aliases?: Record<string, string> | undefined }> },
  name: string,
  resolve: (dimension: string, value: string) => string | null = (_d, v) => v,
): ConventionParse {
  const parts = name.trim().split(convention.delimiter);
  if (parts.length !== convention.tokens.length) return { ok: false, problem: { kind: "parts", expected: convention.tokens.length, found: parts.length } };
  const dimensionValues: Record<string, string> = {};
  for (const [i, token] of convention.tokens.entries()) {
    const raw = (parts[i] ?? "").trim();
    if (raw === "") return { ok: false, problem: { kind: "empty", position: i + 1 } };
    if (token.dimension === null) continue;
    const alias = Object.entries(token.aliases ?? {}).find(([k]) => k.toLowerCase() === raw.toLowerCase());
    const value = alias ? alias[1] : raw;
    const code = resolve(token.dimension, value);
    if (code === null) return { ok: false, problem: { kind: "unknown_value", position: i + 1, dimension: token.dimension, value: raw } };
    dimensionValues[token.dimension] = code;
  }
  return { ok: true, dimensionValues };
}

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
  /** EX-5: why an unmatched campaign stays unassigned, when a rule says so (null: nothing qualified). */
  reason: UnassignedReason.nullable().default(null),
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

