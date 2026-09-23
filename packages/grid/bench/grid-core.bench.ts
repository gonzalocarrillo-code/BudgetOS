import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { measureCellPath } from "./cells.js";
import { measureScrollFps } from "./scroll-fps.js";
import { SPIKE_COLUMN_COUNT, SPIKE_ROW_COUNT } from "./rows.js";

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");

it("keeps the grid-core spike within 10% of the committed baseline", async () => {
  const cells = measureCellPath();
  const glideScrollFpsP50 = await measureScrollFps("glide");
  const tanstackScrollFpsP50 = await measureScrollFps("tanstack");
  const measured = {
    rows: SPIKE_ROW_COUNT,
    columns: SPIKE_COLUMN_COUNT,
    ...cells,
    glideScrollFpsP50,
    tanstackScrollFpsP50,
  };
  if (!existsSync(baselinePath)) {
    throw new Error(`GRID_SPIKE_MEASURED ${JSON.stringify(measured)}`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof measured & { cpuScaleMs: number };
  const detail = JSON.stringify(measured);
  const scale = measured.cpuScaleMs;
  const baselineScale = baseline.cpuScaleMs;
  if (scale <= 0 || baselineScale <= 0) {
    throw new Error("cpu calibration was empty");
  }
  expect(measured.glideVisibleWindowP50Ms / scale, detail).toBeLessThanOrEqual((baseline.glideVisibleWindowP50Ms / baselineScale) * 1.1);
  expect(measured.tanstackVisibleWindowP50Ms / scale, detail).toBeLessThanOrEqual((baseline.tanstackVisibleWindowP50Ms / baselineScale) * 1.1);
  expect(measured.glideGetCellMedianMs / scale, detail).toBeLessThanOrEqual((baseline.glideGetCellMedianMs / baselineScale) * 2);
  expect(measured.tanstackGetCellMedianMs / scale, detail).toBeLessThanOrEqual((baseline.tanstackGetCellMedianMs / baselineScale) * 2);
  expect(measured.glideModelBuildMs / scale, detail).toBeLessThanOrEqual((baseline.glideModelBuildMs / baselineScale) * 1.1);
  expect(measured.tanstackModelBuildMs / scale, detail).toBeLessThanOrEqual((baseline.tanstackModelBuildMs / baselineScale) * 1.1);
  expect(measured.glideScrollFpsP50, detail).toBeGreaterThanOrEqual(baseline.glideScrollFpsP50 * 0.9);
  expect(measured.tanstackScrollFpsP50, detail).toBeGreaterThanOrEqual(baseline.tanstackScrollFpsP50 * 0.9);
});
