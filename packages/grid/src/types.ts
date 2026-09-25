import type { QueryResponse, QueryRow } from "@budget/domain";
import type { Theme } from "@glideapps/glide-data-grid";

export type { QueryRow };

export interface RowSource {
  /** Returns rows for [start, end) of the flattened, expanded tree. Must be stable for the same dataVersion. */
  getRows(range: { start: number; end: number }): Promise<{ rows: QueryRow[]; total: number; dataVersion: string }>;
  /** Expand/collapse a node; the source re-flattens and returns the new total row count. */
  toggle(nodeKey: string): Promise<{ total: number }>;
  subscribe(onInvalidate: () => void): () => void;
}

export type MeasureKey =
  | "budget"
  | "actual"
  | "projected"
  | "variance_abs"
  | "variance_pct"
  | "remaining"
  | "pace_index";

/** `title` and `width` are display only; the caller localises titles (AGENTS §4). */
export type ColumnSpec = (
  | { kind: "path" }
  | { kind: "measure"; key: MeasureKey; editable?: boolean }
  | { kind: "target"; metric: string; field: "target" | "actual" | "vsTargetPct"; editable?: boolean }
  | { kind: "status" }
  | { kind: "chips" }
  | { kind: "dimension"; key: string; editable?: boolean }
) & { title?: string; width?: number };

export interface GridEvents {
  onEdit(event: { row: QueryRow; column: ColumnSpec; value: string }): Promise<void>;
  onPaste(event: { anchor: { row: number; col: number }; cells: string[][] }): void;
  onSelect(row: QueryRow | null): void;
  onExpand?(row: QueryRow): void;
  /** The first (name) cell of a row without children was clicked: open its details. */
  onOpen?(row: QueryRow): void;
  onSort?(column: ColumnSpec): void;
}

export type GridDensity = "compact" | "normal" | "comfortable";
export type PinnedTotals = "top" | "bottom";

export interface BudgetGridProps {
  source: RowSource;
  columns: readonly ColumnSpec[];
  events: GridEvents;
  density?: GridDensity;
  pinnedTotals?: PinnedTotals;
  totals?: QueryResponse["totals"];
  currency?: string;
  searchDimensionValues?: (dimensionKey: string, query: string) => Promise<readonly string[]>;
  searchTags?: (query: string) => Promise<readonly string[]>;
  /** Glide theme overrides (the app's design tokens). */
  theme?: Partial<Theme>;
  /** Label of the pinned totals row's first cell. */
  totalsLabel?: string;
}
