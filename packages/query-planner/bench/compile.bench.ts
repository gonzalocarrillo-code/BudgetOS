import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryRequest } from "@budget/domain";
import { expect, it } from "vitest";
import { compileQuery, metricRegistry } from "../src/compile-query.js";

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
  const samples: number[] = [];
  for (let n = 0; n < 2000; n += 1) {
    compileQuery(request, period, "2026-10-15");
  }
  for (let batch = 0; batch < 15; batch += 1) {
    const start = performance.now();
    for (let n = 0; n < 5000; n += 1) {
      compileQuery(request, period, "2026-10-15");
    }
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const p50 = samples[7];
  expect(p50).toBeTypeOf("number");
  if (p50 === undefined) {
    throw new Error("planner bench produced no samples");
  }
  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { compile5000P50Ms: number };
  expect(p50, `compile5000P50Ms=${p50.toFixed(3)}`).toBeLessThanOrEqual(baseline.compile5000P50Ms * 1.1);
  metricRegistry.delete("cpa");
});
