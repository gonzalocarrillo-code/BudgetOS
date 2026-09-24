import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryRequest } from "@budget/domain";
import { expect, it } from "vitest";
import { compileQuery, metricRegistry } from "../src/compile-query.js";
import { calibrationBatch } from "./calibration.js";

const CALLS_PER_BATCH = 5000;
// 2000 warm-up calls left the timed batches inside V8 tier-up; batch time settles after about 20 batches.
const WARMUP_BATCHES = 40;
const SAMPLE_BATCHES = 31;

interface PlannerBaseline {
  compileToCalibrationP50Ratio: number;
  compile5000P50Ms: number;
  calibration5000P50Ms: number;
  recordedOn: { cpu: string; node: string; date: string };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) {
    throw new Error("planner bench produced no samples");
  }
  return value;
}

it("compileQuery p50 stays within 10% of the committed baseline", () => {
  metricRegistry.set("cpa", { numerator: "spend", denominator: "kpi:conversions" });
  const request = QueryRequest.parse({
    workspaceId: "01927a00-0000-7000-8000-0000000000a1",
    period: { kind: "range", start: "2026-09-01", end: "2026-11-30" },
    groupBy: ["region"],
    measures: ["budget", "actual", "projected", "pace_index"],
    targets: ["cpa"],
    filter: {
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "descends_from", value: "EMEA" },
        { field: { kind: "measure", key: "budget" }, op: "gte", value: 100 },
      ],
    },
    sort: [{ key: "budget", dir: "desc" }],
    limit: 200,
  });
  const period = { start: "2026-09-01", end: "2026-11-30" };
  const compileBatch = () => {
    const start = performance.now();
    for (let n = 0; n < CALLS_PER_BATCH; n += 1) {
      compileQuery(request, period, "2026-10-15");
    }
    return performance.now() - start;
  };
  // Interleave the two loops so both see the same clock speed and the same background load.
  for (let batch = 0; batch < WARMUP_BATCHES; batch += 1) {
    compileBatch();
    calibrationBatch(CALLS_PER_BATCH);
  }
  const compileSamples: number[] = [];
  const calibrationSamples: number[] = [];
  for (let batch = 0; batch < SAMPLE_BATCHES; batch += 1) {
    compileSamples.push(compileBatch());
    calibrationSamples.push(calibrationBatch(CALLS_PER_BATCH));
  }
  metricRegistry.delete("cpa");
  const compileP50 = median(compileSamples);
  const calibrationP50 = median(calibrationSamples);
  const ratio = compileP50 / calibrationP50;

  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");
  if (process.env.BENCH_RECORD === "1") {
    const recorded: PlannerBaseline = {
      compileToCalibrationP50Ratio: Number(ratio.toFixed(4)),
      compile5000P50Ms: Number(compileP50.toFixed(2)),
      calibration5000P50Ms: Number(calibrationP50.toFixed(2)),
      recordedOn: { cpu: cpus()[0]?.model ?? "unknown", node: process.version, date: new Date().toISOString().slice(0, 10) },
    };
    // Merge: execute.bench.ts keeps its own keys in the same file.
    const existing = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
    writeFileSync(baselinePath, `${JSON.stringify({ ...existing, ...recorded }, null, 2)}\n`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PlannerBaseline;
  expect(
    ratio,
    `compileToCalibrationP50Ratio=${ratio.toFixed(4)} compile5000P50Ms=${compileP50.toFixed(2)} calibration5000P50Ms=${calibrationP50.toFixed(2)}`,
  ).toBeLessThanOrEqual(baseline.compileToCalibrationP50Ratio * 1.1);
});
