import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BudgetGrid, type QueryRow, type RowSource } from "../src/index.js";
import { BUDGET_COLUMNS, BUDGET_ROW_COUNT, budgetRow } from "./budget-rows.js";
import { installScrollMeasure } from "./scroll-measure.js";

const source: RowSource = {
  getRows(range) {
    const rows: QueryRow[] = [];
    const end = Math.min(range.end, BUDGET_ROW_COUNT);
    for (let index = range.start; index < end; index += 1) rows.push(budgetRow(index));
    return Promise.resolve({ rows, total: BUDGET_ROW_COUNT, dataVersion: "bench" });
  },
  toggle() {
    return Promise.resolve({ total: BUDGET_ROW_COUNT });
  },
  subscribe() {
    return () => undefined;
  },
};

declare global {
  interface Window {
    __budgetGridMeasure?: () => Promise<{ fps: number; firstPaintMs: number }>;
  }
}

function BudgetBench() {
  const [warm, setWarm] = useState(false);
  const paintStart = useRef<number | null>(null);
  useEffect(() => {
    void Promise.all([
      source.getRows({ start: 0, end: 200 }),
      source.getRows({ start: 200, end: 400 }),
      source.getRows({ start: 400, end: 600 }),
    ]).then(() => setWarm(true));
  }, []);
  if (warm && paintStart.current === null) paintStart.current = performance.now();
  useEffect(() => {
    if (!warm || paintStart.current === null) return;
    const started = paintStart.current;
    let firstPaintMs = 0;
    const watch = (): void => {
      const canvas = document.querySelector("canvas");
      if (canvas instanceof HTMLCanvasElement && firstPaintMs === 0) {
        firstPaintMs = performance.now() - started;
      }
      const scroller = document.querySelector(".dvn-scroller");
      if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) {
        requestAnimationFrame(watch);
        return;
      }
      installScrollMeasure(() => scroller);
      window.__budgetGridMeasure = async () => {
        const measure = window.__gridSpikeMeasure;
        if (measure === undefined) throw new Error("budget grid sampler missing");
        const fps = await measure();
        return { fps, firstPaintMs };
      };
    };
    requestAnimationFrame(watch);
  }, [warm]);
  if (!warm) return null;
  return (
    <div style={{ width: 1280, height: 800, display: "flex", flexDirection: "column" }}>
      <BudgetGrid
        source={source}
        columns={BUDGET_COLUMNS}
        events={{
          onEdit: () => Promise.resolve(),
          onPaste: () => undefined,
          onSelect: () => undefined,
        }}
        totals={{ budget: "100000.00" }}
        currency="USD"
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<BudgetBench />);
