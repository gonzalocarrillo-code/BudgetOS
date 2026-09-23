import type { Meta, StoryObj } from "@storybook/react";
import { DataEditor, type GridColumn } from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { buildCell, customRenderers } from "./cells.js";
import type { ColumnSpec, QueryRow } from "./types.js";

const sample = {
  key: "story-row",
  envelopeId: null,
  depth: 1,
  path: ["LATAM", "Brazil"],
  dimensions: { country: "BR" },
  measures: {
    budget: "1200000.00",
    actual: "800000.00",
    pace_index: "1.10",
  },
  targets: { cpa: { target: "12.00", actual: "10.00", vsTargetPct: "-16.67" } },
  status: "pending",
  pendingCount: 3,
  openAlerts: 1,
  openThreads: 2,
  hasChildren: true,
  expanded: true,
} as QueryRow;

const columns: Record<string, ColumnSpec> = {
  path: { kind: "path" },
  money: { kind: "measure", key: "budget", editable: true },
  pace: { kind: "measure", key: "pace_index" },
  target: { kind: "target", metric: "cpa", field: "vsTargetPct", editable: true },
  status: { kind: "status" },
  chips: { kind: "chips" },
  dimension: { kind: "dimension", key: "country" },
};

function CellFrame({ kind }: { kind: keyof typeof columns }) {
  const column = columns[kind];
  if (column === undefined) return null;
  const glideColumns: GridColumn[] = [{ title: kind, width: 280 }];
  return (
    <DataEditor
      width={480}
      height={120}
      columns={glideColumns}
      rows={1}
      rowHeight={36}
      getCellContent={() => buildCell(sample, column, { currency: "USD" })}
      customRenderers={customRenderers}
    />
  );
}

const meta = { title: "BudgetGrid/Cells" } satisfies Meta;
export default meta;

export const Path: StoryObj = { render: () => <CellFrame kind="path" /> };
export const Money: StoryObj = { render: () => <CellFrame kind="money" /> };
export const Pace: StoryObj = { render: () => <CellFrame kind="pace" /> };
export const Target: StoryObj = { render: () => <CellFrame kind="target" /> };
export const Status: StoryObj = { render: () => <CellFrame kind="status" /> };
export const Chips: StoryObj = { render: () => <CellFrame kind="chips" /> };
export const Dimension: StoryObj = { render: () => <CellFrame kind="dimension" /> };
