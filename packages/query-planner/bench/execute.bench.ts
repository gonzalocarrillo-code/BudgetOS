import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryRequest, type FilterGroupT } from "@budget/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compileQuery, compileTotals, type CompiledQuery } from "../src/compile-query.js";
import { closePools, runAsApp } from "../src/test-support/db.js";
import { seedBenchWorkspace } from "../src/test-support/bench-fixture.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, type FixtureOrg } from "../src/test-support/fixtures.js";

/** Executes planner SQL as budget_app over 2,000 envelopes × 30 spend days; p50 of 21 runs (after 5 warm-ups) vs baseline. */
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

async function p50(c: CompiledQuery): Promise<number> {
  const tenant = { workspaceId: ws, userId: org.users.u1 };
  for (let n = 0; n < 5; n += 1) await runAsApp(c, tenant); // warm plan cache and buffers
  const samples: number[] = [];
  for (let n = 0; n < 21; n += 1) {
    const start = performance.now();
    await runAsApp(c, tenant);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[10] ?? Number.NaN;
}

const baseline = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "baseline.json"), "utf8")) as Record<string, number>;

it.each([
  ["executePageP50Ms", () => compileQuery(request({ sort: [{ key: "budget", dir: "desc" }], limit: 200 }), PERIOD, TODAY)],
  ["executeGroupP50Ms", () => compileQuery(request({ filter, groupBy: ["geo", "platform"] }), PERIOD, TODAY)],
  ["executeTotalsP50Ms", () => compileTotals(request({ filter }), PERIOD, TODAY)],
] as const)("%s stays within 10%% of the committed baseline", async (key, build) => {
  const ms = await p50(build());
  const ref = baseline[key];
  expect(ref, `${key} missing from bench/baseline.json (measured ${ms.toFixed(1)})`).toBeTypeOf("number");
  expect(ms, `${key}=${ms.toFixed(3)}`).toBeLessThanOrEqual((ref ?? 0) * 1.1);
}, 60_000);
