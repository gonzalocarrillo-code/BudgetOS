import { DomainError, type QueryRow } from "@budget/domain";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useState } from "react";
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
  if (column.title !== undefined) return column.title;
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

export function columnWidth(column: ColumnSpec): number {
  if (column.width !== undefined) return column.width;
  return column.kind === "path" ? 240 : 120;
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

/** The path cell indents 16 px a level; its marker sits within the padding + ~18 px (cells.tsx). */
const INDENT_PX = 16;
/** The checkbox column in select mode (the totals row makes room for it). */
const ROW_MARKER_PX = 36;
const MARKER_HIT_PX = 26;
function levelOf(row: QueryRow): number {
  const level = (row as QueryRow & { level?: unknown }).level;
  return typeof level === "number" ? level : 0;
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
  theme,
  totalsLabel = "Total",
  selectRows = false,
}: BudgetGridProps) {
  const cache = useRowCache(source, { pageSize: 200, prefetch: 2 });
  // Glide stores the selection only when it is not given onGridSelectionChange; we need the
  // callback, so the selection is held here (without it, nothing selects and nothing edits).
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  // Leaving select mode drops the ticked rows.
  useEffect(() => {
    if (!selectRows) setSelection((s) => ({ ...s, rows: CompactSelection.empty() }));
  }, [selectRows]);
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
    // cache.version: a new function when rows arrive, so Glide redraws the cells it has.
    [cache, cache.version, columns, currency, pinnedTotals, totals],
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
      {pinnedTotals === "top" ? <TotalsRow columns={columns} totals={totals} currency={currency} widths={columns.map(columnWidth)} label={totalsLabel} offset={selectRows ? ROW_MARKER_PX : 0} /> : null}
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
        rowSelect={selectRows ? "multi" : "single"}
        rowMarkers={selectRows ? "checkbox" : "none"}
        rowMarkerWidth={ROW_MARKER_PX}
        rowSelectionMode={selectRows ? "multi" : "auto"}
        gridSelection={selection}
        onGridSelectionChange={(next) => {
          setSelection(next);
          const current = next.current;
          events.onSelect(current ? (cache.get(current.cell[1]) ?? null) : null);
          if (selectRows) events.onRowsSelected?.([...next.rows].map((i) => cache.get(i)).filter((r): r is NonNullable<typeof r> => r !== undefined));
        }}
        onCellClicked={([col, row], event) => {
          const record = cache.get(row);
          if (col !== 0 || record === undefined) return;
          // A group's marker (▸/▾) expands it; its name opens it when an envelope is the group
          // (a parent budget), like a leaf. A group with no envelope expands from anywhere.
          const opens = record.envelopeId !== null || (record.nodeEnvelopeId ?? null) !== null;
          const onMarker = event.localEventX < MARKER_HIT_PX + levelOf(record) * INDENT_PX;
          if (treeHasChildren(record) && (onMarker || !opens)) {
            void source.toggle(record.key).then(({ total }) => cache.setTotal(total));
            events.onExpand?.(record);
          } else if (opens) {
            events.onOpen?.(record);
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
        theme={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", ...theme }}
      />
      </div>
    </div>
  );
}
