import type { QueryRequest } from "@budget/domain";
import { sanitize } from "@budget/query-planner";
import { Decimal } from "decimal.js";

/**
 * The export's table (plan §6.2): the planner's rows for the query, in its order, with the
 * columns the grid shows. Money is 2-dp text and ratios 6-dp text; the writers decide how a cell
 * lands in the file. The last row is the totals row, computed by the planner, never summed here.
 */

export type CellKind = "text" | "money" | "ratio" | "count";
export interface Column {
  key: string;
  label: string;
  kind: CellKind;
}
export interface ExportTable {
  columns: Column[];
  rows: Array<Array<string | null>>;
  totals: Array<string | null>;
}

type Row = Record<string, unknown>;
const MONEY = new Set(["budget", "actual", "projected", "remaining", "variance_abs"]);
const LABEL: Record<string, string> = {
  budget: "Budget",
  actual: "Actual",
  projected: "Projected",
  remaining: "Remaining",
  variance_abs: "Variance",
  variance_pct: "Variance %",
  pace_index: "Pace index",
  projected_close_pct: "Projected close %",
  spend_to_date_pct: "Spend to date %",
};

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const fixed = (v: unknown, dp: number): string | null => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp));
const cell = (kind: CellKind, v: unknown) => (kind === "money" ? fixed(v, 2) : kind === "ratio" ? fixed(v, 6) : kind === "count" ? (v === null || v === undefined ? "0" : String(v)) : text(v));

export interface TableContext {
  /** Every dimension of the workspace, in display order. */
  dimensions: Array<{ key: string; label: string }>;
  /** Envelope id → path (root … envelope); flat rows only. */
  paths: Map<string, string[]>;
  reportingCurrency: string;
}

export function buildTable(q: QueryRequest, rows: Row[], totals: Row, ctx: TableContext): ExportTable {
  const measures = [...new Set(q.measures)];
  const targets = [...new Set(q.targets)];
  const measureCols: Column[] = measures.map((m) => ({ key: m, label: LABEL[m] ?? m, kind: MONEY.has(m) ? "money" : "ratio" }));
  const dimLabel = new Map(ctx.dimensions.map((d) => [d.key, d.label]));
  const columns: Column[] = [];
  const read: Array<(r: Row) => unknown> = [];
  const add = (c: Column, f: (r: Row) => unknown) => {
    columns.push(c);
    read.push(f);
  };

  if (q.groupBy.length > 0) {
    for (const k of q.groupBy) {
      const s = sanitize(k);
      add({ key: k, label: dimLabel.get(k) ?? k, kind: "text" }, (r) => r[`dim_${s}`]);
      add({ key: `${k}_label`, label: `${dimLabel.get(k) ?? k} (label)`, kind: "text" }, (r) => r[`lbl_${s}`]);
    }
    add({ key: "currency", label: "Currency", kind: "text" }, () => ctx.reportingCurrency);
    for (const c of measureCols) add(c, (r) => r[c.key]);
    for (const t of targets) add({ key: t, label: t.toUpperCase(), kind: "ratio" }, (r) => r[`kpi_${sanitize(t)}`]);
    add({ key: "leaf_count", label: "Envelopes", kind: "count" }, (r) => r["leaf_count"]);
    add({ key: "pending_count", label: "Pending", kind: "count" }, (r) => r["pending_count"]);
  } else {
    const present = new Set(rows.flatMap((r) => Object.keys((r["dimension_values"] ?? {}) as Record<string, unknown>)));
    const dims = [...ctx.dimensions.filter((d) => present.has(d.key)), ...[...present].filter((k) => !dimLabel.has(k)).sort().map((key) => ({ key, label: key }))];
    add({ key: "envelope_id", label: "Envelope id", kind: "text" }, (r) => r["envelope_id"]);
    add({ key: "path", label: "Path", kind: "text" }, (r) => (ctx.paths.get(String(r["envelope_id"])) ?? [String(r["name"])]).join(" / "));
    add({ key: "name", label: "Name", kind: "text" }, (r) => r["name"]);
    add({ key: "status", label: "Status", kind: "text" }, (r) => r["status"]);
    for (const d of dims) add({ key: d.key, label: d.label, kind: "text" }, (r) => ((r["dimension_values"] ?? {}) as Record<string, unknown>)[d.key]);
    add({ key: "currency", label: "Currency", kind: "text" }, () => ctx.reportingCurrency);
    for (const c of measureCols) add(c, (r) => r[c.key]);
    for (const t of targets) {
      const s = sanitize(t);
      add({ key: t, label: t.toUpperCase(), kind: "ratio" }, (r) => r[`kpi_${s}`]);
      add({ key: `${t}_target`, label: `${t.toUpperCase()} target`, kind: "ratio" }, (r) => r[`tgt_${s}`]);
      add({ key: `${t}_vs_target`, label: `${t.toUpperCase()} vs target`, kind: "ratio" }, (r) => r[`vs_${s}`]);
    }
    add({ key: "open_alerts", label: "Open alerts", kind: "count" }, (r) => r["open_alerts"]);
    add({ key: "open_threads", label: "Open threads", kind: "count" }, (r) => r["open_threads"]);
  }

  const body = rows.map((r) => columns.map((c, i) => cell(c.kind, (read[i] as (r: Row) => unknown)(r))));
  // Totals: the first column says so; measures and grouped KPIs come from compileTotals.
  const totalsRow = columns.map((c, i): string | null => {
    if (i === 0) return "Total";
    if (c.key === "currency") return ctx.reportingCurrency;
    if (measures.includes(c.key as (typeof measures)[number])) return cell(c.kind, totals[c.key]);
    if (targets.includes(c.key)) return cell(c.kind, totals[`kpi_${sanitize(c.key)}`]);
    if (c.key === "leaf_count") return cell("count", totals["leaf_count"]);
    return null;
  });
  return { columns, rows: body, totals: totalsRow };
}
