import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals, metricRegistry } from "./index.js";
import { closePools, owner, runAsApp } from "./test-support/db.js";
import { cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * ADR-071: a superseded fact (a full re-extract no longer had it, or its warehouse row moved) is
 * kept for history but read by nothing: not `actual` (whole months from spend_month, edges from
 * spend_fact), not KPI facts, not derived KPIs, not projected spend.
 */

let org: FixtureOrg;
let ws: string;
let env: string;
const supersede = (table: string, date: string) => owner.query(`UPDATE ${table} SET superseded_at = now(), superseded_by_run_id = $3::uuid WHERE workspace_id = $1::uuid AND period_date = $2::date`, [ws, date, randomUUID()]);
const restore = (table: string, date: string) => owner.query(`UPDATE ${table} SET superseded_at = NULL, superseded_by_run_id = NULL WHERE workspace_id = $1::uuid AND period_date = $2::date`, [ws, date]);
const PERIOD = { start: "2026-01-01", end: "2026-02-14" }; // January whole (spend_month), February an edge (spend_fact)
const RUN_OLD = randomUUID();
const RUN_NEW = randomUUID();

async function measures(): Promise<{ actual: string; cpa: string; conv: string; projected: string }> {
  const q = QueryRequest.parse({ workspaceId: ws, measures: ["actual", "projected"], targets: ["cpa", "conv"], period: { kind: "range", ...PERIOD }, limit: 10 });
  const [row] = await runAsApp(compileQuery(q, PERIOD, "2026-02-14", { hasProjections: true }), { workspaceId: ws, userId: null });
  const [tot] = await runAsApp(compileTotals(q, PERIOD, "2026-02-14"), { workspaceId: ws, userId: null });
  expect(new Decimal(String(tot?.["actual"])).equals(String(row?.["actual"]))).toBe(true);
  const n = (v: unknown) => new Decimal(String(v)).toString();
  return { actual: n(row?.["actual"]), cpa: n(row?.["kpi_cpa"]), conv: n(row?.["kpi_conv"]), projected: n(row?.["projected"]) };
}
const month = async (m: string) => (await owner.query<{ amount: string; n: string }>(`SELECT amount_reporting::text AS amount, fact_count::text AS n FROM spend_month WHERE workspace_id = $1::uuid AND envelope_id = $2::uuid AND month = $3::date`, [ws, env, m])).rows;

beforeAll(async () => {
  metricRegistry.set("cpa", { numerator: "spend", denominator: "kpi:conversions" });
  metricRegistry.set("conv", { numerator: "kpi:conversions", denominator: null });
  org = await createOrg();
  ws = await createWorkspace(org);
  env = (
    await insertEnvelope(org, ws, {
      name: "superseded",
      status: "APPROVED",
      start: "2026-01-01",
      end: "2026-12-31",
      versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-01T00:00:00Z" }],
      spend: [
        { date: "2026-01-05", amount: "100.00" },
        { date: "2026-01-20", amount: "60.00" },
        { date: "2026-02-03", amount: "40.00" },
        { date: "2026-02-10", amount: "20.00" },
      ],
      kpi: [
        { date: "2026-01-05", metric: "conversions", value: "10" },
        { date: "2026-01-20", metric: "conversions", value: "6" },
        { date: "2026-02-03", metric: "conversions", value: "4" },
      ],
      projections: [
        { date: "2026-02-01", value: "300", runId: RUN_OLD, loadedAt: "2026-02-01T00:00:00Z" },
        { date: "2026-02-01", value: "900", runId: RUN_NEW, loadedAt: "2026-02-10T00:00:00Z" },
      ],
    })
  ).id;
});

afterAll(async () => {
  metricRegistry.delete("cpa");
  metricRegistry.delete("conv");
  if (org) await cleanupOrg(org);
  await closePools();
});

describe("superseded facts (ADR-071)", () => {
  it("are excluded from actual, KPI facts, derived KPIs and projected spend, and come back when restored", async () => {
    expect(await measures()).toEqual({ actual: "220", cpa: "11", conv: "20", projected: "900" });

    await supersede("spend_fact", "2026-01-20"); // a whole month: spend_month must drop it
    await supersede("spend_fact", "2026-02-10"); // an edge day: read from spend_fact
    await supersede("kpi_fact", "2026-02-03");
    await owner.query(`UPDATE projection_fact SET superseded_at = now() WHERE workspace_id = $1::uuid AND source_run_id = $2::uuid`, [ws, RUN_NEW]);
    expect(await month("2026-01-01")).toEqual([{ amount: "100.00", n: "1" }]);
    expect(await measures()).toEqual({ actual: "140", cpa: "8.75", conv: "16", projected: "300" });

    await restore("spend_fact", "2026-01-20");
    expect(await month("2026-01-01")).toEqual([{ amount: "160.00", n: "2" }]);
    expect((await measures()).actual).toBe("200");
  });
});
