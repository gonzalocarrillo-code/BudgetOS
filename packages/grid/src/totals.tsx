import type { ColumnSpec } from "./types.js";
import { formatMoney } from "./editors.js";

export function TotalsRow({
  columns,
  totals,
  currency,
}: {
  columns: readonly ColumnSpec[];
  totals: Readonly<Record<string, string | null>>;
  currency: string;
}) {
  return (
    <div className="budget-grid-totals" role="row" style={{ display: "flex", fontVariantNumeric: "tabular-nums" }}>
      {columns.map((column, index) => (
        <span key={`${column.kind}-${index}`} role="cell" style={{ minWidth: 96, padding: "4px 8px", textAlign: "right" }}>
          {totalText(column, totals, currency)}
        </span>
      ))}
    </div>
  );
}

function totalText(column: ColumnSpec, totals: Readonly<Record<string, string | null>>, currency: string): string {
  if (column.kind === "measure") {
    const value = totals[column.key];
    if (value === undefined || value === null) return "";
    if (column.key === "pace_index") return value;
    return formatMoney(value, currency);
  }
  if (column.kind === "target") {
    const value = totals[`${column.metric}.${column.field}`] ?? totals[column.metric];
    if (value === undefined || value === null) return "";
    return column.field === "vsTargetPct" ? `${value}%` : formatMoney(value, currency);
  }
  return "";
}
