import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";

/**
 * Phase E (ADR-053, docs/BUDGET_HISTORY_PLAN.md): snapshots saved by hand, the change report, and
 * ending and reintroducing budgets. Money crosses the boundary as decimal strings.
 */
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const BaselineKind = z.enum(["plan", "close", "other"]);
export type BaselineKind = z.infer<typeof BaselineKind>;

/** What a snapshot covers: the whole workspace ({}), one budget and its subtree, or a filter's budgets. */
export const BaselineScope = z.union([z.object({ envelopeId: z.string().uuid() }).strict(), z.object({ filter: FilterGroup }).strict(), z.object({}).strict()]);
export type BaselineScope = z.infer<typeof BaselineScope>;

/** POST /workspaces/:ws/baselines — taken now. */
export const CreateBaselineInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: BaselineKind.default("other"),
  scope: BaselineScope.default({}),
  periodKey: z.string().trim().max(40).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type CreateBaselineInput = z.infer<typeof CreateBaselineInput>;

/** PATCH /baselines/:id — rename, change the note or kind, archive or bring back. */
export const UpdateBaselineInput = z
  .object({ name: z.string().trim().min(1).max(120).optional(), note: z.string().trim().max(1000).nullable().optional(), kind: BaselineKind.optional(), archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateBaselineInput = z.infer<typeof UpdateBaselineInput>;

export const BaselineView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: BaselineKind,
  scope: z.record(z.string(), z.unknown()),
  scopeLabel: z.string().nullable(),
  periodKey: z.string().nullable(),
  asOf: z.string(),
  note: z.string().nullable(),
  takenBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  rowCount: z.number().int(),
  total: money,
});
export type BaselineView = z.infer<typeof BaselineView>;
export const BaselinesResponse = z.object({ baselines: z.array(BaselineView) });
export type BaselinesResponse = z.infer<typeof BaselinesResponse>;

/** GET /baselines/:id/report?against=<baselineId> — against now when absent. */
export const BaselineReportQuery = z.object({ against: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(20) });
export type BaselineReportQuery = z.infer<typeof BaselineReportQuery>;

const Mover = z.object({
  envelopeId: z.string().uuid(),
  name: z.string(),
  baseline: money,
  now: money,
  abs: money,
  pct: z.string().nullable(),
  status: z.enum(["changed", "new", "removed", "ended"]),
});
export const BaselineReport = z.object({
  baseline: z.object({ id: z.string().uuid(), name: z.string(), asOf: z.string(), total: money }),
  against: z.object({ kind: z.enum(["working", "baseline"]), id: z.string().uuid().nullable(), name: z.string(), asOf: z.string(), total: money }),
  change: z.object({ abs: money, pct: z.string().nullable() }),
  counts: z.object({ increased: z.number().int(), decreased: z.number().int(), new: z.number().int(), removed: z.number().int(), ended: z.number().int(), unchanged: z.number().int() }),
  byDimension: z.record(z.string(), z.array(z.object({ code: z.string(), label: z.string(), baseline: money, now: money, abs: money, pct: z.string().nullable() }))),
  topMovers: z.array(Mover),
  currency: z.string(),
});
export type BaselineReport = z.infer<typeof BaselineReport>;

/** POST /envelopes/:id/reintroduce, or `successor` inside End: the budget that continues an ended one. */
export const ReintroduceInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  startDate: isoDate,
  endDate: isoDate,
  amount: money,
  rationale: z.string().trim().max(2000).default(""),
});
export type ReintroduceInput = z.infer<typeof ReintroduceInput>;

/** POST /envelopes/:id/end: stop the budget on endDate with its final amount, through the approval policy. */
export const EndEnvelopeInput = z.object({
  endDate: isoDate,
  finalAmount: money,
  rationale: z.string().trim().max(2000).default(""),
  basedOnVersionId: z.string().uuid(),
  successor: ReintroduceInput.omit({ rationale: true }).optional(),
});
export type EndEnvelopeInput = z.infer<typeof EndEnvelopeInput>;
