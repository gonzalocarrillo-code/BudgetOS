import type { ManualEntryIssue, ManualEntryRowInput } from "@budget/domain";
import type { QueryRow, RowSource } from "@budget/grid";

/**
 * The manual entry grid's local RowSource (spec §26.2, "<BudgetGrid/> in entry mode"): the batch's
 * rows as typed, plus one blank row at the end to type into. Nothing is computed here: the server
 * validates, totals and returns the issues on every save. Non-dimension fields travel as
 * `@`-prefixed pseudo-dimensions so the grid's text editor can hold them.
 */

export const FIELD = { date: "@date", currency: "@currency", note: "@note", kpi: (metric: string) => `@kpi:${metric}` } as const;
export type EntryRow = ManualEntryRowInput & { rowNo: number };

const blankRow = (rowNo: number): EntryRow => ({ rowNo, dimensionValues: {}, periodDate: "", currency: "", amount: "", kpis: {} });

export class EntrySource implements RowSource {
  private rows: EntryRow[];
  private issues = new Map<number, ManualEntryIssue[]>();
  private readonly listeners = new Set<() => void>();

  constructor(rows: readonly ManualEntryRowInput[], private readonly editable: boolean, issues: readonly ManualEntryIssue[] = []) {
    this.rows = rows.map((r, i) => ({ ...r, rowNo: i + 1 }));
    for (const i of issues) this.issues.set(i.rowNo, [...(this.issues.get(i.rowNo) ?? []), i]);
  }

  /** Rows to save: every row but the trailing blank one. */
  get value(): ManualEntryRowInput[] {
    return this.rows.map((r) => ({ dimensionValues: r.dimensionValues, periodDate: r.periodDate, currency: r.currency, amount: r.amount, kpis: r.kpis, ...(r.note ? { note: r.note } : {}) }));
  }

  setIssues(issues: readonly ManualEntryIssue[]): void {
    this.issues = new Map();
    for (const i of issues) this.issues.set(i.rowNo, [...(this.issues.get(i.rowNo) ?? []), i]);
    this.emit();
  }

  /** Replaces the rows with the server's (normalized, renumbered) after a save nobody typed over. */
  reset(rows: readonly ManualEntryRowInput[]): void {
    this.rows = rows.map((r, i) => ({ ...r, rowNo: i + 1 }));
    this.emit();
  }

  private toQueryRow(r: EntryRow, blank: boolean): QueryRow {
    const issues = this.issues.get(r.rowNo) ?? [];
    const dims: Record<string, string | null> = { ...r.dimensionValues, [FIELD.date]: r.periodDate, [FIELD.currency]: r.currency, [FIELD.note]: r.note ?? "" };
    for (const [metric, value] of Object.entries(r.kpis)) dims[FIELD.kpi(metric)] = value;
    return {
      key: blank ? "new" : String(r.rowNo),
      envelopeId: null,
      path: [blank ? "+" : issues.length ? `${r.rowNo} ⚠` : String(r.rowNo)],
      dimensions: dims,
      measures: { actual: r.amount === "" ? null : r.amount },
      targets: {},
      status: null,
      pendingCount: 0,
      openAlerts: 0,
      openThreads: 0,
    };
  }

  async getRows(range: { start: number; end: number }) {
    const all = [...this.rows.map((r) => this.toQueryRow(r, false)), ...(this.editable ? [this.toQueryRow(blankRow(this.rows.length + 1), true)] : [])];
    return { rows: all.slice(range.start, range.end), total: all.length, dataVersion: String(this.rows.length) };
  }

  async toggle() {
    return { total: this.rows.length + (this.editable ? 1 : 0) };
  }

  subscribe(onInvalidate: () => void): () => void {
    this.listeners.add(onInvalidate);
    return () => this.listeners.delete(onInvalidate);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /** Sets one field of a row (the blank row becomes a new one). `field`: a dimension key, `amount`, or an `@` field. */
  set(rowKey: string, field: string, value: string): void {
    const index = rowKey === "new" ? this.rows.length : Number(rowKey) - 1;
    this.setAt(index, field, value);
    this.emit();
  }

  /** Paste: a block of cells from (row, field index), growing the batch as needed. */
  paste(startRow: number, fields: readonly string[], cells: readonly string[][]): void {
    cells.forEach((line, i) => line.forEach((value, j) => {
      const field = fields[j];
      if (field !== undefined) this.setAt(startRow + i, field, value);
    }));
    this.emit();
  }

  private setAt(index: number, field: string, raw: string): void {
    while (this.rows.length <= index) this.rows.push(blankRow(this.rows.length + 1));
    const row = this.rows[index] as EntryRow;
    const value = raw.trim();
    if (field === "amount") row.amount = value;
    else if (field === FIELD.date) row.periodDate = value;
    else if (field === FIELD.currency) row.currency = value.toUpperCase();
    else if (field === FIELD.note) row.note = value;
    else if (field.startsWith("@kpi:")) row.kpis = { ...row.kpis, [field.slice(5)]: value };
    else row.dimensionValues = { ...row.dimensionValues, [field]: value };
  }
}
