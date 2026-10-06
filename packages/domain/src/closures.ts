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
export const RunSourceInput = z
  .object({
    restatementOf: z.string().uuid().optional(),
    /** ADR-071: run an incremental source as a full extract once (it sees deletes and re-keys). */
    fullResync: z.boolean().optional(),
  })
  .strict();
export type RunSourceInput = z.infer<typeof RunSourceInput>;

/**
 * The workspace's fiscal calendar (product feedback 7, ADR-041): its periods — years, quarters,
 * months as defined, and custom partitions — each with its closure state.
 */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PeriodKind = z.enum(["year", "quarter", "month", "custom"]);
export const CreatePeriodInput = z
  .object({ key: z.string().trim().min(1).max(80), kind: PeriodKind.default("custom"), start: IsoDate, end: IsoDate })
  .refine((p) => p.start <= p.end, { message: "A period starts on or before it ends", path: ["end"] });
export type CreatePeriodInput = z.infer<typeof CreatePeriodInput>;
export const UpdatePeriodInput = z
  .object({ key: z.string().trim().min(1).max(80).optional(), start: IsoDate.optional(), end: IsoDate.optional() })
  .strict()
  .refine((p) => p.start === undefined || p.end === undefined || p.start <= p.end, { message: "A period starts on or before it ends", path: ["end"] });
export type UpdatePeriodInput = z.infer<typeof UpdatePeriodInput>;
export const GeneratePeriodsInput = z.object({ fiscalYear: z.number().int().min(2000).max(2100), pattern: z.enum(["calendar", "445", "454", "544"]).default("calendar") });
export type GeneratePeriodsInput = z.infer<typeof GeneratePeriodsInput>;
export const PeriodRow = z.object({
  id: z.string().uuid(),
  key: z.string(),
  kind: z.string(),
  start: z.string(),
  end: z.string(),
  closure: z.object({ id: z.string().uuid(), status: z.string() }).nullable(),
});
export type PeriodRow = z.infer<typeof PeriodRow>;
