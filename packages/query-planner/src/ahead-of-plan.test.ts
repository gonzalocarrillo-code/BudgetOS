import { QueryRequest, type Predicate } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileAggregateBq, compileQuery, compileTotals } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * HO-009 (ADR-064): ahead of plan in money, `actual − budget_in_period × elapsed`, derived at query
 * time like every measure. Q1 (90 days) counted through 31 January (31 days): a 9,000 budget with
 * 3,000 spent is 100 behind its 3,100 share; spend with no budget is all ahead.
 */
let org: FixtureOrg;
let ws: string;
const OPTS = { elapsedThrough: "2026-01-31" };

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  await insertEnvelope(org, ws, { name: "Search", parentId: null, platform: "google", geo: "br", status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "9000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }], spend: [{ date: "2026-01-20", amount: "3000.00" }] });
  await insertEnvelope(org, ws, { name: "Unbudgeted", parentId: null, platform: "google", geo: "mx", status: "DRAFT", start: PERIOD.start, end: PERIOD.end, versions: [], spend: [{ date: "2026-01-15", amount: "500.00" }] });
  const ended = await insertEnvelope(org, ws, { name: "Stopped", parentId: null, platform: "meta", geo: "br", status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }] });
  await owner.query(`UPDATE envelope SET ended_at = now() WHERE id = $1`, [ended.id]);
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const LIVE: Predicate = { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" };
const LIVE_NOT_ENDED: Predicate[] = [LIVE, { field: { kind: "attr", key: "is_ended" }, op: "eq", value: false }];
const request = (over: Record<string, unknown> = {}) => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["actual", "budget_in_period", "ahead_of_plan_abs"], filter: { logic: "and", children: LIVE_NOT_ENDED }, sort: [{ key: "name", dir: "asc" }], ...over });
const as = () => ({ workspaceId: ws, userId: org.users.u1 });
const money = (v: unknown) => new Decimal(String(v)).toFixed(2);

describe("ahead of plan (ADR-064)", () => {
  it("per budget: spend less its budget's share of the time gone", async () => {
    const rows = await runAsApp(compileQuery(request(), PERIOD, TODAY, OPTS), as());
    expect(rows.map((r) => [r["name"], money(r["ahead_of_plan_abs"])])).toEqual([
      ["Search", "-100.00"],
      ["Unbudgeted", "500.00"],
    ]);
  });

  it("groups and totals add their rows up (time gone is the same for all)", async () => {
    const [group] = await runAsApp(compileQuery(request({ groupBy: ["platform"], sort: [] }), PERIOD, TODAY, OPTS), as());
    expect(money((group as Row)["ahead_of_plan_abs"])).toBe("400.00");
    const [t] = await runAsApp(compileTotals(request(), PERIOD, TODAY, OPTS), as());
    expect(money((t as Row)["ahead_of_plan_abs"])).toBe("400.00");
  });

  it("sorts, so the largest gaps come first", async () => {
    const rows = await runAsApp(compileQuery(request({ sort: [{ key: "ahead_of_plan_abs", dir: "asc" }] }), PERIOD, TODAY, OPTS), as());
    expect(rows.map((r) => r["name"])).toEqual(["Search", "Unbudgeted"]);
  });

  it("is_ended keeps ended budgets out (HO-010), or picks them", async () => {
    const ended = await runAsApp(compileQuery(request({ filter: { logic: "and", children: [LIVE, { field: { kind: "attr", key: "is_ended" }, op: "eq", value: true }] } }), PERIOD, TODAY, OPTS), as());
    expect(ended.map((r) => r["name"])).toEqual(["Stopped"]);
  });

  it("BigQuery computes it the same way from the group's sums", () => {
    const bq = compileAggregateBq(request({ groupBy: ["platform"], sort: [], filter: { logic: "and", children: [LIVE] } }), PERIOD, TODAY, "proj.ds", OPTS);
    expect(bq.sql).toContain("SUM(m.actual) - COALESCE(SUM(m.budget_in_period), 0) * @elapsed AS ahead_of_plan_abs");
    expect(bq.params["elapsed"]).toBe(new Decimal(31).div(90).toString());
  });
});
