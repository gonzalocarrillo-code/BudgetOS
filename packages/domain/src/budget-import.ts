import { z } from "zod";
import { normTerm } from "./sources.js";

/**
 * Budget CSV import (docs/DATA_PLAN.md §3, D-007 to D-009): a template the app writes from the
 * workspace's registry, a validation report and a preview, then drafts under one approval. A file
 * only ever produces drafts (AGENTS §9).
 */

/** Columns every template has, besides one per active dimension and one per fiscal month. */
export const BUDGET_IMPORT_COLUMNS = ["key", "parent_key", "name", "currency", "amount", "start_date", "end_date", "envelope_id", "rationale"] as const;
export const BUDGET_IMPORT_MAX_ROWS = 5_000;

/** GET /workspaces/:ws/budget-import/template: parents come from this hierarchy template's order (the default when absent). */
export const BudgetImportTemplateQuery = z.object({ templateId: z.string().uuid().optional() });

/** POST /workspaces/:ws/budget-import/preview. */
export const BudgetImportInput = z.object({
  csv: z.string().min(1).max(10_000_000),
  templateId: z.string().uuid().optional(),
});
export type BudgetImportInput = z.infer<typeof BudgetImportInput>;

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

export const BudgetImportProblem = z.object({ column: z.string().nullable(), message: z.string(), suggestion: z.string().nullable().optional() });
export const BudgetImportLine = z.object({
  /** The file's line number (1 = the header). */
  line: z.number().int(),
  status: z.enum(["new", "change", "same", "error"]),
  envelopeId: z.string().uuid().nullable(),
  name: z.string(),
  dimensionValues: z.record(z.string(), z.string()),
  currency: z.string().nullable(),
  amount: money.nullable(),
  /** The approved amount now, for a change or a same row. */
  currentAmount: money.nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  /** The parent it will sit under: an existing budget's id, or the path of a parent the import creates. */
  parent: z.object({ envelopeId: z.string().uuid().nullable(), name: z.string() }).nullable(),
  problems: z.array(BudgetImportProblem),
});
export type BudgetImportLine = z.infer<typeof BudgetImportLine>;

export const BudgetImportParent = z.object({
  name: z.string(),
  dimensionValues: z.record(z.string(), z.string()),
  currency: z.string(),
  /** A new parent holds the sum of what the import puts under it. */
  amount: money,
  startDate: z.string(),
  endDate: z.string(),
  parent: z.object({ envelopeId: z.string().uuid().nullable(), name: z.string() }).nullable(),
});
export type BudgetImportParent = z.infer<typeof BudgetImportParent>;
export const BudgetImportOverCap = z.object({ envelopeId: z.string().uuid(), name: z.string(), approved: money, childrenAfter: money });
export type BudgetImportOverCap = z.infer<typeof BudgetImportOverCap>;

export const BudgetImportPreview = z.object({
  previewId: z.string().uuid(),
  lines: z.array(BudgetImportLine),
  /** Parents the import creates from the hierarchy (or from parent_key). */
  parents: z.array(BudgetImportParent),
  /** Existing parents whose children would add up to more than their budget. */
  overCap: z.array(BudgetImportOverCap),
  counts: z.object({ new: z.number().int(), change: z.number().int(), same: z.number().int(), error: z.number().int(), parents: z.number().int() }),
  /** Reporting currency: new budgets' total and the change to existing ones. */
  totals: z.object({ new: money, change: money }),
  currency: z.string(),
  /** Header cells that are neither a granularity, a month nor a template column: they are ignored. */
  unknownColumns: z.array(z.string()),
  /** Why Commit is not possible, or null. */
  blocked: z.string().nullable(),
});
export type BudgetImportPreview = z.infer<typeof BudgetImportPreview>;

/** POST /workspaces/:ws/budget-import/commit: the preview's plan, re-checked, as drafts under one approval. */
export const BudgetImportCommitInput = z.object({ previewId: z.string().uuid(), rationale: z.string().trim().min(3).max(4000) });
export type BudgetImportCommitInput = z.infer<typeof BudgetImportCommitInput>;

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] as number;
}

/**
 * "Did you mean": the code whose code, label or alias is closest to `raw`, when it is close enough
 * to be a typo (a third of the longer word), compared in the guesser's normal form.
 */
export function nearestCode(raw: string, candidates: ReadonlyArray<{ code: string; names: readonly string[] }>): string | null {
  const target = normTerm(raw);
  let best: { code: string; d: number; len: number } | null = null;
  for (const c of candidates) {
    for (const n of c.names) {
      const name = normTerm(n);
      const d = editDistance(target, name);
      if (best === null || d < best.d) best = { code: c.code, d, len: name.length };
    }
  }
  return best && best.d <= Math.max(1, Math.floor(Math.max(target.length, best.len) * 0.34)) ? best.code : null;
}
