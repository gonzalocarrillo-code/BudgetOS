import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryRequest, type FilterGroupT } from "@budget/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compileQuery, compileTotals, type CompiledQuery } from "../src/compile-query.js";
import { closePools, runAsApp } from "../src/test-support/db.js";
import { seedBenchWorkspace } from "../src/test-support/bench-fixture.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, type FixtureOrg } from "../src/test-support/fixtures.js";

/** Executes planner SQL as budget_app over 2,000 envelopes × 30 spend days; gates p50 / DB-calibration p50 vs baseline. */
const ENVELOPES = 2_000;
const SPEND_DAYS = 30;
let org: FixtureOrg;
let ws: string;

const filter: FilterGroupT = {
  logic: "and",
  children: [
    { field: { kind: "dimension", key: "geo" }, op: "descends_from", value: "latam" },
    {
      logic: "or",
      children: [
        { field: { kind: "measure", key: "pace_index" }, op: "gt", value: 0.5 },
        { field: { kind: "attr", key: "status" }, op: "in", value: ["APPROVED", "PENDING"] },
      ],
    },
  ],
};
const request = (over: Record<string, unknown>) => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, ...over });

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  await seedBenchWorkspace(org, ws, ENVELOPES, SPEND_DAYS);
}, 60_000);

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

/**
 * DB-side calibration: a fixed aggregate the planner's work resembles (scan + numeric sums),
 * run as the same role through the same pool. Interleaving it with each sample makes the gated
 * ratio insensitive to machine load and clock speed, as the compile bench does (ADR-006).
 */
const CALIBRATION: CompiledQuery = {
  sql: "SELECT sum(x::numeric * 1.01) AS s FROM generate_series(1, 150000) x",
  values: [],
  orderKeys: [],
};

async function timed(c: CompiledQuery, tenant: { workspaceId: string; userId: string }): Promise<number> {
  const start = performance.now();
  await runAsApp(c, tenant);
  return performance.now() - start;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

async function measure(c: CompiledQuery): Promise<{ ms: number; calibrationMs: number }> {
  const tenant = { workspaceId: ws, userId: org.users.u1 };
  for (let n = 0; n < 5; n += 1) {
    await timed(c, tenant); // warm plan cache and buffers
    await timed(CALIBRATION, tenant);
  }
  const samples: number[] = [];
  const calibration: number[] = [];
  for (let n = 0; n < 21; n += 1) {
    samples.push(await timed(c, tenant));
    calibration.push(await timed(CALIBRATION, tenant));
  }
  return { ms: median(samples), calibrationMs: median(calibration) };
}

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
const recorded: Record<string, number> = {};

afterAll(() => {
  if (process.env["BENCH_RECORD"] === "1" && Object.keys(recorded).length > 0) {
    const existing = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
    writeFileSync(baselinePath, `${JSON.stringify({ ...existing, ...recorded }, null, 2)}\n`);
  }
});

it.each([
  ["executePage", () => compileQuery(request({ sort: [{ key: "budget", dir: "desc" }], limit: 200 }), PERIOD, TODAY)],
  ["executeGroup", () => compileQuery(request({ filter, groupBy: ["geo", "platform"] }), PERIOD, TODAY)],
  ["executeTotals", () => compileTotals(request({ filter }), PERIOD, TODAY)],
] as const)("%s p50 / calibration p50 stays within 10%% of the committed baseline", async (key, build) => {
  const { ms, calibrationMs } = await measure(build());
  const ratio = ms / calibrationMs;
  const label = `${key}ToCalibrationP50Ratio=${ratio.toFixed(4)} ${key}P50Ms=${ms.toFixed(2)} calibrationP50Ms=${calibrationMs.toFixed(2)}`;
  if (process.env["BENCH_RECORD"] === "1") {
    recorded[`${key}ToCalibrationP50Ratio`] = Number(ratio.toFixed(4));
    recorded[`${key}P50Ms`] = Number(ms.toFixed(2));
    recorded["executeCalibrationP50Ms"] = Number(calibrationMs.toFixed(2));
    return; // recording: nothing to compare against yet
  }
  const ref = baseline[`${key}ToCalibrationP50Ratio`];
  expect(ref, `${key}ToCalibrationP50Ratio missing from bench/baseline.json (${label})`).toBeTypeOf("number");
  expect(ratio, label).toBeLessThanOrEqual((ref as number) * 1.1);
}, 120_000);
