import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildCell } from "../src/cells.js";
import { BUDGET_COLUMNS, budgetRow } from "./budget-rows.js";
import { measurePage } from "./scroll-fps.js";

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

function cpuScale(): number {
  const samples: number[] = [];
  let sink = 0;
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < 4_000_000; n += 1) sink = (sink + n) % 997;
    samples.push(performance.now() - start);
  }
  if (sink < 0) throw new Error("cpu calibration did not run");
  return percentile(samples, 0.5);
}

function cellP95Ms(): number {
  const times: number[] = [];
  for (let sample = 0; sample < 30; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < 240; n += 1) {
      const column = BUDGET_COLUMNS[n % BUDGET_COLUMNS.length];
      if (column === undefined) throw new Error("missing bench column");
      const cell = buildCell(budgetRow(n), column, { currency: "USD" });
      if (cell.accessibilityString.length === 0) throw new Error("cell missing accessibility");
    }
    times.push((performance.now() - start) / 240);
  }
  return percentile(times, 0.95);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

it("scrolls BudgetGrid at 55 fps p50 on 100k in-memory rows", async () => {
  if (BUDGET_COLUMNS.length !== 12) throw new Error("bench is not 12 columns");
  const scale = cpuScale();
  const getCellP95Ms = cellP95Ms();
  const raw = await measurePage(
    "scroll-budget.tsx",
    "typeof window.__budgetGridMeasure",
    "window.__budgetGridMeasure()",
  );
  if (!isRecord(raw) || typeof raw["fps"] !== "number" || typeof raw["firstPaintMs"] !== "number") {
    throw new Error(`budget grid measure was ${JSON.stringify(raw)}`);
  }
  const measured = {
    budgetGridScrollFpsP50: Number(raw["fps"].toFixed(1)),
    budgetGridGetCellP95Ms: Number(getCellP95Ms.toFixed(4)),
    budgetGridFirstPaintMs: Number(raw["firstPaintMs"].toFixed(1)),
    cpuScaleMs: Number(scale.toFixed(3)),
  };
  if (!existsSync(baselinePath)) throw new Error(`BUDGET_GRID_MEASURED ${JSON.stringify(measured)}`);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
  const baselineFps = baseline["budgetGridScrollFpsP50"];
  const baselineCell = baseline["budgetGridGetCellP95Ms"];
  const baselinePaint = baseline["budgetGridFirstPaintMs"];
  const baselineScale = baseline["cpuScaleMs"];
  if (
    typeof baselineFps !== "number" ||
    typeof baselineCell !== "number" ||
    typeof baselinePaint !== "number" ||
    typeof baselineScale !== "number"
  ) {
    throw new Error(`BUDGET_GRID_MEASURED ${JSON.stringify(measured)}`);
  }
  const detail = JSON.stringify(measured);
  expect(measured.budgetGridScrollFpsP50, detail).toBeGreaterThanOrEqual(55);
  expect(measured.budgetGridScrollFpsP50, detail).toBeGreaterThanOrEqual(baselineFps * 0.9);
  expect(measured.budgetGridGetCellP95Ms, detail).toBeLessThan(0.2);
  expect(measured.budgetGridFirstPaintMs, detail).toBeLessThan(300);
  if (scale <= 0 || baselineScale <= 0) throw new Error("cpu calibration was empty");
  expect(measured.budgetGridGetCellP95Ms / scale, detail).toBeLessThanOrEqual((baselineCell / baselineScale) * 2);
  expect(measured.budgetGridFirstPaintMs / scale, detail).toBeLessThanOrEqual((baselinePaint / baselineScale) * 1.1);
});
