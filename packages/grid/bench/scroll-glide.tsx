import { DataEditor, GridCellKind, type GridCell, type GridColumn, type Item } from "@glideapps/glide-data-grid";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SPIKE_COLUMNS, SPIKE_ROW_COUNT, SPIKE_ROW_HEIGHT, materializeRows } from "./rows.js";
import { installScrollMeasure } from "./scroll-measure.js";

const rows = materializeRows();
const columns: GridColumn[] = SPIKE_COLUMNS.map((title) => ({ title, width: 120 }));

function getCellContent([col, row]: Item): GridCell {
  const record = rows[row];
  const key = SPIKE_COLUMNS[col];
  const value = record !== undefined && key !== undefined ? record[key] : "";
  return {
    kind: GridCellKind.Text,
    data: value,
    displayData: value,
    allowOverlay: false,
    copyData: value,
  };
}

function GlideSpike() {
  useEffect(() => {
    installScrollMeasure(() => {
      const element = document.querySelector(".dvn-scroller");
      return element instanceof HTMLElement ? element : null;
    });
  }, []);
  return (
    <DataEditor
      width={1280}
      height={800}
      columns={columns}
      rows={SPIKE_ROW_COUNT}
      getCellContent={getCellContent}
      rowHeight={SPIKE_ROW_HEIGHT}
      smoothScrollX
      smoothScrollY
    />
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
createRoot(root).render(<GlideSpike />);
