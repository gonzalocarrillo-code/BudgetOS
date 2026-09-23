import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SPIKE_BAR_COUNT } from "./bars.js";
import { measureEngine } from "./chrome.js";

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid === undefined) {
    throw new Error("cpu calibration produced no samples");
  }
  return mid;
}

function cpuScale(): number {
  const samples: number[] = [];
  let sink = 0;
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < 4_000_000; n += 1) {
      sink = (sink + n) % 997;
    }
    samples.push(performance.now() - start);
  }
  if (sink < 0) {
    throw new Error("cpu calibration did not run");
  }
  const scale = median(samples);
  if (scale <= 0) {
    throw new Error("cpu calibration was empty");
  }
  return Number(scale.toFixed(3));
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function roundFps(value: number): number {
  return Number(value.toFixed(1));
}

it("keeps the 5k-bar timeline spike within 10% of the committed baseline", async () => {
  const cpuScaleMs = cpuScale();
  const svar = await measureEngine("svar");
  const vis = await measureEngine("vis");
  const canvas = await measureEngine("canvas");
  const measured = {
    bars: SPIKE_BAR_COUNT,
    targetLaneProven: svar.targetLaneProven && vis.targetLaneProven && canvas.targetLaneProven,
    markerOverlayProven: svar.markerOverlayProven && vis.markerOverlayProven && canvas.markerOverlayProven,
    cpuScaleMs,
    svarRenderP95Ms: roundMs(svar.renderP95Ms),
    visRenderP95Ms: roundMs(vis.renderP95Ms),
    canvasRenderP95Ms: roundMs(canvas.renderP95Ms),
    svarPanFpsP50: roundFps(svar.panFpsP50),
    visPanFpsP50: roundFps(vis.panFpsP50),
    canvasPanFpsP50: roundFps(canvas.panFpsP50),
  };
  if (!measured.targetLaneProven || !measured.markerOverlayProven) {
    throw new Error(`timeline spike did not prove lanes and overlay ${JSON.stringify(measured)}`);
  }
  if (!existsSync(baselinePath)) {
    throw new Error(`TIMELINE_SPIKE_MEASURED ${JSON.stringify(measured)}`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof measured;
  const detail = JSON.stringify(measured);
  const scale = measured.cpuScaleMs;
  const baselineScale = baseline.cpuScaleMs;
  if (scale <= 0 || baselineScale <= 0) {
    throw new Error("cpu calibration was empty");
  }
  expect(measured.svarRenderP95Ms / scale, detail).toBeLessThanOrEqual((baseline.svarRenderP95Ms / baselineScale) * 1.1);
  expect(measured.visRenderP95Ms / scale, detail).toBeLessThanOrEqual((baseline.visRenderP95Ms / baselineScale) * 1.1);
  expect(measured.canvasRenderP95Ms / scale, detail).toBeLessThanOrEqual((baseline.canvasRenderP95Ms / baselineScale) * 1.1);
  expect(measured.svarPanFpsP50, detail).toBeGreaterThanOrEqual(baseline.svarPanFpsP50 * 0.9);
  expect(measured.visPanFpsP50, detail).toBeGreaterThanOrEqual(baseline.visPanFpsP50 * 0.9);
  expect(measured.canvasPanFpsP50, detail).toBeGreaterThanOrEqual(baseline.canvasPanFpsP50 * 0.9);
});
