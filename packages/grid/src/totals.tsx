import type { ColumnSpec } from "./types.js";
import { formatMoney } from "./editors.js";

/**
 * The pinned totals row above the canvas. Values are the API's totals (never summed here), laid
 * out on the grid's own column widths.
 */
export function TotalsRow({
  columns,
  totals,
  currency,
  widths,
  label = "Total",
}: {
  columns: readonly ColumnSpec[];
  totals: Readonly<Record<string, string | null>>;
  currency: string;
  widths?: readonly number[];
  label?: string;
}) {
  return (
    <div className="budget-grid-totals" role="row" data-testid="grid-totals" style={{ display: "flex", fontVariantNumeric: "tabular-nums", fontWeight: 600, whiteSpace: "nowrap" }}>
      {columns.map((column, index) => (
        <span
          key={`${column.kind}-${index}`}
          role="cell"
          data-column={column.kind === "measure" ? column.key : column.kind}
          style={{ width: widths?.[index] ?? 96, flex: "none", padding: "8px", textAlign: index === 0 ? "left" : "right", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {index === 0 ? label : totalText(column, totals, currency)}
        </span>
      ))}
    </div>
  );
}

function totalText(column: ColumnSpec, totals: Readonly<Record<string, string | null>>, currency: string): string {
  if (column.kind === "measure") {
    const value = totals[column.key];
    if (value === undefined || value === null) return "";
    if (column.key === "pace_index") return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : value;
    return formatMoney(value, currency);
  }
  if (column.kind === "target") {
    const value = totals[`${column.metric}.${column.field}`] ?? totals[column.metric];
    if (value === undefined || value === null) return "";
    return column.field === "vsTargetPct" ? `${value}%` : formatMoney(value, currency);
  }
  return "";
}
