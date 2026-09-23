import { DomainError, type QueryRow } from "@budget/domain";
import {
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback } from "react";
import { buildCell, customRenderers, type BudgetCell } from "./cells.js";
import { bindEditorHost } from "./editor-fields.js";
import { forwardPaste } from "./paste.js";
import { useRowCache } from "./row-cache.js";
import { TotalsRow } from "./totals.js";
import type { BudgetGridProps, ColumnSpec, GridDensity } from "./types.js";

function rowHeight(density: GridDensity): number {
  if (density === "compact") return 28;
  if (density === "comfortable") return 44;
  return 36;
}

function columnTitle(column: ColumnSpec): string {
  switch (column.kind) {
    case "path":
      return "path";
    case "measure":
      return column.key;
    case "target":
      return `${column.metric}.${column.field}`;
    case "status":
      return "status";
    case "chips":
      return "chips";
    case "dimension":
      return column.key;
  }
}

function columnWidth(column: ColumnSpec): number {
  if (column.kind === "path") return column.width ?? 240;
  return 120;
}

function committedValue(cell: EditableGridCell): string {
  if (cell.kind === GridCellKind.Custom) {
    const data = cell.data as { value?: string | null };
    return typeof data.value === "string" ? data.value : cell.copyData;
  }
  if (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Markdown || cell.kind === GridCellKind.Uri) {
    return cell.data;
  }
  if (cell.kind === GridCellKind.Number) return cell.data === undefined ? "" : String(cell.data);
  if (cell.kind === GridCellKind.Boolean) return cell.data === true ? "true" : "false";
  if (cell.kind === GridCellKind.Image) return cell.data.join(",");
  return "";
}

function treeHasChildren(row: QueryRow): boolean {
  return (row as QueryRow & { hasChildren?: unknown }).hasChildren === true;
}

function totalsCell(row: QueryRow, column: ColumnSpec, currency: string, totals: Readonly<Record<string, string | null>>): BudgetCell {
  if (column.kind === "measure") {
    const value = totals[column.key] ?? null;
    return buildCell({ ...row, measures: { ...row.measures, [column.key]: value } }, column, { currency });
  }
  if (column.kind === "target") {
    const value = totals[`${column.metric}.${column.field}`] ?? totals[column.metric] ?? null;
    const current = row.targets[column.metric] ?? { target: null, actual: null, vsTargetPct: null };
    return buildCell(
      {
        ...row,
        targets: {
          ...row.targets,
          [column.metric]: { ...current, [column.field]: value },
        },
      },
      column,
      { currency },
    );
  }
  return buildCell(row, column, { currency });
}

export function BudgetGrid({
  source,
  columns,
  events,
  density = "normal",
  pinnedTotals = "top",
  totals = {},
  currency = "USD",
  searchDimensionValues,
  searchTags,
}: BudgetGridProps) {
  const cache = useRowCache(source, { pageSize: 200, prefetch: 2 });
  bindEditorHost({
    ...(searchDimensionValues === undefined ? {} : { searchDimensionValues }),
    ...(searchTags === undefined ? {} : { searchTags }),
  });

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const column = columns[col];
      if (column === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
      if (pinnedTotals === "bottom" && row === cache.total) {
        const anchor = cache.get(0);
        if (anchor === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
        return totalsCell(anchor, column, currency, totals);
      }
      const record = cache.get(row);
      if (record === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
      return buildCell(record, column, { currency });
    },
    [cache, columns, currency, pinnedTotals, totals],
  );

  const onCellEdited = useCallback(
    async ([col, row]: Item, newValue: EditableGridCell) => {
      const record = cache.get(row);
      const column = columns[col];
      if (record === undefined || column === undefined || !("editable" in column) || column.editable !== true) return;
      try {
        await events.onEdit({ row: record, column, value: committedValue(newValue) });
      } catch (error) {
        if (error instanceof DomainError && error.code === "CONFLICT") return;
        throw error;
      }
    },
    [cache, columns, events],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      {pinnedTotals === "top" ? <TotalsRow columns={columns} totals={totals} currency={currency} /> : null}
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        <DataEditor
        width="100%"
        height="100%"
        columns={columns.map((column) => ({ title: columnTitle(column), width: columnWidth(column), id: columnTitle(column) }))}
        rows={cache.total}
        getCellContent={getCellContent}
        onCellEdited={(cell, value) => {
          void onCellEdited(cell, value);
        }}
        freezeColumns={1}
        rowHeight={rowHeight(density)}
        headerHeight={40}
        customRenderers={customRenderers}
        onPaste={(target, values) => forwardPaste(events, target, values)}
        getCellsForSelection={true}
        rangeSelect="multi-rect"
        columnSelect="none"
        rowSelect="single"
        onGridSelectionChange={(selection) => {
          const current = selection.current;
          events.onSelect(current ? (cache.get(current.cell[1]) ?? null) : null);
        }}
        onCellClicked={([col, row]) => {
          const record = cache.get(row);
          if (col === 0 && record !== undefined && treeHasChildren(record)) {
            void source.toggle(record.key).then(({ total }) => cache.setTotal(total));
            events.onExpand?.(record);
          }
        }}
        onHeaderClicked={(col) => {
          const column = columns[col];
          if (column !== undefined) events.onSort?.(column);
        }}
        keybindings={{ search: false }}
        smoothScrollX
        smoothScrollY
        {...(pinnedTotals === "bottom" ? { trailingRowOptions: { sticky: true } } : {})}
        theme={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
      />
      </div>
    </div>
  );
}
