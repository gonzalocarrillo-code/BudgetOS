import { z } from "zod";

/**
 * Manual result entry (spec §26, plan §6.1): offline or non-integrated actuals (TV, OOH, print…)
 * typed or pasted into a grid, one batch per channel and period, sent for approval. Approved rows
 * become spend and KPI facts with `source_system='manual'`; a batch never writes budgets.
 *
 * Rows are saved as typed (strings), so a half-finished grid can be kept: each save validates
 * every row against the registry the way ingestion does and returns the issues. A batch with an
 * issue cannot be submitted.
 */

const IsoDate = z.string().date();

export const ManualEntryStatus = z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]);
export type ManualEntryStatus = z.infer<typeof ManualEntryStatus>;

/** One grid row as entered. Dimension values may be codes, aliases or external ids (resolved on save). */
export const ManualEntryRowInput = z.object({
  rowNo: z.number().int().min(1).optional(),
  dimensionValues: z.record(z.string().min(1).max(64), z.string().max(200)).default({}),
  periodDate: z.string().max(20).default(""),
  currency: z.string().max(10).default(""),
  amount: z.string().max(40).default(""),
  /** KPI metric → value, e.g. { conversions: "120", impressions: "450000" }. */
  kpis: z.record(z.string().min(1).max(64), z.string().max(40)).default({}),
  note: z.string().max(1000).optional(),
});
export type ManualEntryRowInput = z.infer<typeof ManualEntryRowInput>;

export const MANUAL_ENTRY_MAX_ROWS = 2000;

/** POST /workspaces/:ws/manual-entries — a DRAFT batch for one channel and period. */
export const CreateManualEntryInput = z
  .object({
    channel: z.string().min(1).max(64),
    periodStart: IsoDate,
    periodEnd: IsoDate,
    rows: z.array(ManualEntryRowInput).max(MANUAL_ENTRY_MAX_ROWS).default([]),
  })
  .refine((v) => v.periodStart <= v.periodEnd, { message: "periodStart after periodEnd", path: ["periodEnd"] });
export type CreateManualEntryInput = z.infer<typeof CreateManualEntryInput>;

/** PATCH /manual-entries/:id — replaces the rows (and optionally the channel or period) of a DRAFT batch. */
export const UpdateManualEntryInput = z
  .object({
    channel: z.string().min(1).max(64).optional(),
    periodStart: IsoDate.optional(),
    periodEnd: IsoDate.optional(),
    rows: z.array(ManualEntryRowInput).max(MANUAL_ENTRY_MAX_ROWS).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type UpdateManualEntryInput = z.infer<typeof UpdateManualEntryInput>;

/** GET /workspaces/:ws/manual-entries?status=&channel= */
export const ListManualEntriesQuery = z.object({
  status: z.string().regex(/^(DRAFT|SUBMITTED|APPROVED|REJECTED)(,(DRAFT|SUBMITTED|APPROVED|REJECTED))*$/).optional(),
  channel: z.string().max(64).optional(),
});
export type ListManualEntriesQuery = z.infer<typeof ListManualEntriesQuery>;

/** Why a row cannot be loaded: the row, the field (`dimension:<key>`, `periodDate`, `amount`…) and the reason. */
export const ManualEntryIssue = z.object({ rowNo: z.number().int(), field: z.string(), message: z.string() });
export type ManualEntryIssue = z.infer<typeof ManualEntryIssue>;

/** Totals computed on save: the reporting-currency sum (null while a row has no FX rate) and per currency. */
export const ManualEntryTotals = z.object({ amount: z.string().nullable(), byCurrency: z.record(z.string(), z.string()), rows: z.number().int() });
export type ManualEntryTotals = z.infer<typeof ManualEntryTotals>;

/** The summary behind "Send for approval" being disabled: how many rows have which kind of problem. */
export function issueSummary(issues: readonly ManualEntryIssue[]): Array<{ field: string; rows: number }> {
  const byField = new Map<string, Set<number>>();
  for (const i of issues) byField.set(i.field, (byField.get(i.field) ?? new Set()).add(i.rowNo));
  return [...byField.entries()].map(([field, rows]) => ({ field, rows: rows.size })).sort((a, b) => b.rows - a.rows || a.field.localeCompare(b.field));
}
