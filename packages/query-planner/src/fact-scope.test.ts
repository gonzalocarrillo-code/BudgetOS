import { randomUUID } from "node:crypto";
import type { FilterGroupT } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFactSeries, compileFactTotals, type FactScopeRequest, type MetricDef } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * EX-2 (ADR-086): campaign vs campaign on facts. Totals equal Σ facts; derived KPIs are weighted
 * (Σspend / Σconversions, not the mean of daily CPAs); a day with no fact row is `has_data = false`
 * with null metrics (never 0); superseded facts are not read; demo facts follow T-5.
 */

let org: FixtureOrg;
let ws: string;
let env: string;
const WINDOW = { start: "2026-01-01", end: "2026-01-10" };
const TODAY = "2026-01-06";
const DERIVED = new Map<string, MetricDef>([
  ["cpa", { numerator: "spend", denominator: "kpi:conversions" }],
  ["roas", { numerator: "kpi:revenue", denominator: "spend" }],
]);
const campaign = (code: string): FilterGroupT => ({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: code }] });

async function spend(date: string, code: string, amount: string, opts: { envelopeId?: string | null; demo?: boolean; superseded?: boolean } = {}) {
  await owner.query(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, demo, superseded_at)
     VALUES ($1, $2, $3::jsonb, $4, 'USD', $5, $5, 'fixture', $6, $7, $8, $9)`,
    [ws, opts.envelopeId === undefined ? env : opts.envelopeId, JSON.stringify({ platform: "meta", campaign: code }), date, amount, randomUUID(), randomUUID(), opts.demo ?? false, opts.superseded ? new Date() : null],
  );
}
async function kpi(date: string, code: string, metric: string, value: string, opts: { envelopeId?: string | null } = {}) {
  await owner.query(
    `INSERT INTO kpi_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'fixture', $7, $8)`,
    [ws, opts.envelopeId === undefined ? env : opts.envelopeId, JSON.stringify({ platform: "meta", campaign: code }), date, metric, value, randomUUID(), randomUUID()],
  );
}

const req = (over: Partial<FactScopeRequest> = {}): FactScopeRequest => ({ workspaceId: ws, filter: campaign("cmp_a"), ...WINDOW, kpiMetrics: ["conversions", "revenue"], derived: DERIVED, ...over });
const n = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(4).toString());

async function totals(r: FactScopeRequest): Promise<Row> {
  const c = compileFactTotals(r, TODAY);
  const [row] = await runAsApp({ ...c, orderKeys: [] }, { workspaceId: ws, userId: null });
  const named: Row = { days_in_window: row?.["days_in_window"], days_with_data: row?.["days_with_data"], spend: n(row?.["spend"]) };
  for (const k of c.columns.kpi) named[k.metric] = n(row?.[k.col]);
  for (const d of c.columns.derived) named[d.key] = n(row?.[d.col]);
  return named;
}
async function series(r: FactScopeRequest): Promise<Row[]> {
  const c = compileFactSeries(r, TODAY);
  const rows = await runAsApp({ ...c, orderKeys: [] }, { workspaceId: ws, userId: null });
  return rows.map((row) => {
    const named: Row = { date: row["period_date"], hasData: row["has_data"], spend: n(row["spend"]) };
    for (const k of c.columns.kpi) named[k.metric] = n(row[k.col]);
    for (const d of c.columns.derived) named[d.key] = n(row[d.col]);
    return named;
  });
}

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  env = (await insertEnvelope(org, ws, { name: "BR Meta", geo: "br", platform: "meta", status: "APPROVED", start: "2026-01-01", end: "2026-12-31", versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-01T00:00:00Z" }] })).id;
  // Campaign A: 01-01 matched, 01-02 unmatched (no budget), 01-03 only a superseded row, 01-04 spend without KPIs, 01-05 demo only.
  await spend("2026-01-01", "cmp_a", "100.00");
  await kpi("2026-01-01", "cmp_a", "conversions", "10");
  await kpi("2026-01-01", "cmp_a", "revenue", "300");
  await spend("2026-01-02", "cmp_a", "50.00", { envelopeId: null });
  await kpi("2026-01-02", "cmp_a", "conversions", "2", { envelopeId: null });
  await spend("2026-01-03", "cmp_a", "999.00", { superseded: true });
  await spend("2026-01-04", "cmp_a", "30.00");
  await spend("2026-01-05", "cmp_a", "500.00", { demo: true });
  // After today: never read.
  await spend("2026-01-08", "cmp_a", "70.00");
  // Campaign B: 01-01 spend + conversions, 01-03 conversions only.
  await spend("2026-01-01", "cmp_b", "40.00");
  await kpi("2026-01-01", "cmp_b", "conversions", "4");
  await kpi("2026-01-03", "cmp_b", "conversions", "1");
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

describe("fact-scoped totals and daily series (EX-2)", () => {
  it("campaign A vs B: totals equal Σ facts over the days with data; CPA is weighted, not averaged", async () => {
    const a = await totals(req());
    expect(a).toEqual({ days_in_window: 6, days_with_data: 3, spend: "180", conversions: "12", revenue: "300", cpa: "15", roas: "1.6667" });
    // The mean of A's daily CPAs (10 and 25) is 17.5: the planner never averages ratios.
    expect(a["cpa"]).not.toBe("17.5");
    const b = await totals(req({ filter: campaign("cmp_b") }));
    expect(b).toEqual({ days_in_window: 6, days_with_data: 2, spend: "40", conversions: "5", revenue: null, cpa: "8", roas: null });
  });

  it("one row per day to today; a day with no facts is has_data false with null metrics, never 0", async () => {
    const days = await series(req());
    expect(days.map((d) => d["date"])).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"]);
    expect(days[0]).toEqual({ date: "2026-01-01", hasData: true, spend: "100", conversions: "10", revenue: "300", cpa: "10", roas: "3" });
    expect(days[1]).toEqual({ date: "2026-01-02", hasData: true, spend: "50", conversions: "2", revenue: null, cpa: "25", roas: null });
    // Only a superseded row: no data.
    expect(days[2]).toEqual({ date: "2026-01-03", hasData: false, spend: null, conversions: null, revenue: null, cpa: null, roas: null });
    // Spend without KPIs: spend is there, conversions and CPA are null (not 0, not infinite).
    expect(days[3]).toEqual({ date: "2026-01-04", hasData: true, spend: "30", conversions: null, revenue: null, cpa: null, roas: null });
    // Demo only, in a workspace with a real budget (T-5): no data.
    expect(days[4]).toMatchObject({ date: "2026-01-05", hasData: false, spend: null });
    expect(days[5]).toMatchObject({ date: "2026-01-06", hasData: false, spend: null });
    // KPI-only day for B: has data, spend null.
    const b = await series(req({ filter: campaign("cmp_b") }));
    expect(b[2]).toEqual({ date: "2026-01-03", hasData: true, spend: null, conversions: "1", revenue: null, cpa: null, roas: null });
  });

  it("includeDemo reads demo facts; an envelope set or read scope keeps only facts matched to it", async () => {
    expect((await totals(req({ includeDemo: true })))["spend"]).toBe("680");
    // The unmatched 01-02 facts are not on the envelope.
    expect(await totals(req({ envelopeIds: [env] }))).toMatchObject({ days_with_data: 2, spend: "130", conversions: "10" });
    const scope: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "eq", value: "br" }] };
    expect((await totals(req({ envelopeScope: scope })))["spend"]).toBe("130");
    const elsewhere: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "eq", value: "mx" }] };
    expect(await totals(req({ envelopeScope: elsewhere }))).toMatchObject({ days_with_data: 0, spend: null, cpa: null });
  });

  it("a window that has not started has no days; budget-based metrics and non-dimension predicates are refused", async () => {
    expect(await totals(req({ start: "2026-02-01", end: "2026-02-28" }))).toMatchObject({ days_in_window: 0, days_with_data: 0, spend: null });
    expect(() => compileFactTotals(req({ derived: new Map([["burn", { numerator: "spend", denominator: "budget" }]]) }), TODAY)).toThrow(/budget/);
    expect(() => compileFactTotals(req({ filter: { logic: "and", children: [{ field: { kind: "measure", key: "actual" }, op: "gt", value: 1 }] } }), TODAY)).toThrow(/dimensions only/);
  });

  it("in / nin / contains on the registry label work on fact dimensions", async () => {
    const both: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "in", value: ["cmp_a", "cmp_b"] }] };
    expect((await totals(req({ filter: both })))["spend"]).toBe("220");
    const notA: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "nin", value: ["cmp_a"] }] };
    expect((await totals(req({ filter: notA })))["spend"]).toBe("40");
    const like: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "contains", value: "MP_B" }] };
    expect((await totals(req({ filter: like })))["spend"]).toBe("40");
  });
});
