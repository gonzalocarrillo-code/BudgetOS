import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SPIKE_COLUMNS, SPIKE_ROW_COUNT, SPIKE_ROW_HEIGHT, materializeRows, type SpikeRow } from "./rows.js";
import { installScrollMeasure } from "./scroll-measure.js";

const rows = materializeRows();
const helper = createColumnHelper<SpikeRow>();
const columns = SPIKE_COLUMNS.map((key) =>
  helper.accessor(key, {
    id: key,
    header: key,
    size: 120,
  }),
);

function TanstackSpike() {
  const parentRef = useRef<HTMLDivElement>(null);
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const model = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: SPIKE_ROW_COUNT,
    getScrollElement: () => parentRef.current,
    estimateSize: () => SPIKE_ROW_HEIGHT,
    overscan: 5,
  });

  useEffect(() => {
    installScrollMeasure(() => parentRef.current);
  }, []);

  return (
    <div
      ref={parentRef}
      data-spike-scroll=""
      style={{ height: 800, width: 1280, overflow: "auto" }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = model[item.index];
          if (row === undefined) {
            return null;
          }
          return (
            <div
              key={row.id}
              style={{
                position: "absolute",
                top: item.start,
                height: SPIKE_ROW_HEIGHT,
                display: "flex",
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <div key={cell.id} style={{ width: 120 }}>
                  {String(cell.getValue())}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
createRoot(root).render(<TanstackSpike />);
