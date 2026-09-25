import { z } from "zod";

/**
 * Period closures (spec §15, plan §4.5). A closure locks every live envelope that overlaps a fiscal
 * period, snapshots the registry and writes the budget vs actual rows of every hierarchy template
 * to the closure sink (BigQuery). A restatement (admin + reason) unlocks them; the next closure of
 * the period writes a new table version (`_r<N>`), never over the old one.
 */

/** `FY2026`, `2026-Q1` (fiscal quarter) or `2026-03` (calendar month): the keys resolvePeriod reads. */
export const FiscalPeriodKey = z.string().regex(/^(FY\d{4}|\d{4}-Q[1-4]|\d{4}-(0[1-9]|1[0-2]))$/, "FY2026, 2026-Q1 or 2026-03");
export type FiscalPeriodKey = z.infer<typeof FiscalPeriodKey>;

export const fiscalPeriodKind = (key: string): "year" | "quarter" | "month" => (key.startsWith("FY") ? "year" : key.includes("-Q") ? "quarter" : "month");

/** POST /workspaces/:ws/closures: an existing fiscal_period by id, or by key (created on first use). */
export const CloseInput = z
  .object({ periodId: z.string().uuid().optional(), periodKey: FiscalPeriodKey.optional() })
  .strict()
  .refine((v) => (v.periodId === undefined) !== (v.periodKey === undefined), "Give exactly one of periodId or periodKey");
export type CloseInput = z.infer<typeof CloseInput>;

export const RestateInput = z.object({ reason: z.string().trim().min(3).max(2000) });
export type RestateInput = z.infer<typeof RestateInput>;

export const ClosureStatus = z.enum(["closed", "restated"]);

export const ClosureView = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  period: z.object({ id: z.string().uuid(), key: z.string(), kind: z.string(), start: z.string().date(), end: z.string().date() }),
  status: ClosureStatus,
  closedBy: z.string().uuid(),
  closedAt: z.string().datetime(),
  /** Where the rows were written: `closures.budget_vs_actual_<workspace>_<period>[_r<N>]`. */
  table: z.string(),
  lockedEnvelopes: z.number().int(),
});
export type ClosureView = z.infer<typeof ClosureView>;

/** Optional body of POST /sources/:id/run: load facts into the period of a closed closure (spec §15). */
export const RunSourceInput = z.object({ restatementOf: z.string().uuid().optional() }).strict();
export type RunSourceInput = z.infer<typeof RunSourceInput>;
