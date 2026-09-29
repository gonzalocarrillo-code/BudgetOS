import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals, pageOf } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * H-004 done-when (docs/BUDGET_HISTORY_PLAN.md §2.4, ADR-053): `compareTo` gives each budget its
 * amount then (a snapshot's frozen row, or the version approved at an instant) and the change since.
 * Groups and totals add up: Σ sub-groups' change = the group's change, Σ groups = totals, and a
 * group's change % is its total change over its total baseline.
 *
 * | env | geo   | platform | 15 Jan (plan) | now  | change |
 * |-----|-------|----------|---------------|------|--------|
 * | A   | br    | meta     | 1000          | 1300 | +300   |
 * | B   | mx    | meta     | 500           | 500  | 0      |
 * | C   | de    | tiktok   | —             | 400  | +400 (new) |
 * | D   | br_sp | google   | 700           | 200  | −500   |
 */
let org: FixtureOrg;
let ws: string;
let baselineId: string;
const ids: Record<"A" | "B" | "C" | "D", string> = { A: "", B: "", C: "", D: "" };
const PLAN_AT = "2026-01-15T00:00:00Z";

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  const env = (name: string, geo: string, platform: string, versions: Array<[string, string]>) =>
    insertEnvelope(org, ws, {
      name,
      geo,
      platform,
      status: "APPROVED",
      start: "2026-01-01",
      end: "2026-03-31",
      versions: versions.map(([amount, at], i) => ({ amount, status: i === versions.length - 1 ? "APPROVED" : "SUPERSEDED", approvedAt: at })),
    });
  ids.A = (await env("A br meta", "br", "meta", [["1000.00", "2026-01-05T00:00:00Z"], ["1300.00", "2026-02-01T00:00:00Z"]])).id;
  ids.B = (await env("B mx meta", "mx", "meta", [["500.00", "2026-01-05T00:00:00Z"]])).id;
  ids.C = (await env("C de tiktok", "de", "tiktok", [["400.00", "2026-02-01T00:00:00Z"]])).id;
  ids.D = (await env("D sp google", "br_sp", "google", [["700.00", "2026-01-05T00:00:00Z"], ["200.00", "2026-02-01T00:00:00Z"]])).id;
  // A snapshot saved on 15 Jan: A, B and D (C did not exist yet), as captureBaselineRows writes it.
  baselineId = randomUUID();
  await owner.query(
    `INSERT INTO budget_baseline (id, workspace_id, name, kind, scope, as_of, taken_by, row_count, total_reporting) VALUES ($1, $2, 'Q1 plan', 'plan', '{}', $3, $4, 3, 2200)`,
    [baselineId, ws, PLAN_AT, org.users.u1],
  );
  for (const [key, amount] of [["A", "1000.00"], ["B", "500.00"], ["D", "700.00"]] as const) {
    await owner.query(
      `INSERT INTO budget_baseline_row (baseline_id, workspace_id, envelope_id, version_id, amount, amount_reporting, currency, parent_id, name, dimension_values, start_date, end_date, is_leaf)
       VALUES ($1, $2, $3, NULL, $4, $4, 'USD', NULL, $5, '{}', '2026-01-01', '2026-03-31', true)`,
      [baselineId, ws, ids[key], amount, key],
    );
  }
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const MEASURES = ["budget", "budget_baseline", "budget_change_abs", "budget_change_pct"];
const request = (over: Record<string, unknown>) => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 1000, measures: MEASURES, ...over });
const run = (q: QueryRequest) => runAsApp(compileQuery(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
const totals = async (q: QueryRequest) => (await runAsApp(compileTotals(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 }))[0] as Row;
const dec = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(4));
const byId = (rows: Row[]) => new Map(rows.map((r) => [String(r["envelope_id"]), r]));

describe("compareTo (H-004)", () => {
  for (const [label, compareTo] of [
    ["a snapshot", () => ({ baselineId })],
    ["an instant", () => ({ asOf: PLAN_AT })],
  ] as const) {
    it(`against ${label}: each budget's amount then, and its change`, async () => {
      const rows = byId(await run(request({ compareTo: compareTo() })));
      const at = (k: keyof typeof ids) => rows.get(ids[k]) as Row;
      expect([dec(at("A")["budget_baseline"]), dec(at("A")["budget_change_abs"]), dec(at("A")["budget_change_pct"])]).toEqual(["1000.0000", "300.0000", "0.3000"]);
      expect([dec(at("B")["budget_baseline"]), dec(at("B")["budget_change_abs"])]).toEqual(["500.0000", "0.0000"]);
      expect([dec(at("C")["budget_baseline"]), dec(at("C")["budget_change_abs"]), dec(at("C")["budget_change_pct"])]).toEqual([null, "400.0000", null]);
      expect([dec(at("D")["budget_change_abs"]), dec(at("D")["budget_change_pct"])]).toEqual(["-500.0000", "-0.7143"]);
      const t = await totals(request({ compareTo: compareTo() }));
      expect([dec(t["budget"]), dec(t["budget_baseline"]), dec(t["budget_change_abs"])]).toEqual(["2400.0000", "2200.0000", "200.0000"]);
      expect(dec(t["budget_change_pct"])).toBe(new Decimal(200).div(2200).toFixed(4));
    });
  }

  it("Σ sub-groups' change = the group's change, Σ groups = totals, and the group % is Σchange / Σbaseline", async () => {
    const compareTo = { baselineId };
    const byPlatform = await run(request({ compareTo, groupBy: ["platform"] }));
    const byPlatformGeo = await run(request({ compareTo, groupBy: ["platform", "geo"] }));
    const t = await totals(request({ compareTo }));
    const sum = (rows: Row[], k: string) => rows.reduce((s, r) => s.plus(String(r[k] ?? 0)), new Decimal(0)).toFixed(4);
    expect(sum(byPlatform, "budget_change_abs")).toBe(dec(t["budget_change_abs"]));
    expect(sum(byPlatform, "budget_baseline")).toBe(dec(t["budget_baseline"]));
    for (const g of byPlatform) {
      const subs = byPlatformGeo.filter((r) => r["dim_platform"] === g["dim_platform"]);
      expect(sum(subs, "budget_change_abs")).toBe(dec(g["budget_change_abs"]));
    }
    const meta = byPlatform.find((r) => r["dim_platform"] === "meta") as Row;
    expect([dec(meta["budget_baseline"]), dec(meta["budget_change_abs"]), dec(meta["budget_change_pct"])]).toEqual(["1500.0000", "300.0000", "0.2000"]);
  });

  it("works with subtree rows (a parent reads its own amounts)", async () => {
    const rows = byId(await run(request({ compareTo: { baselineId }, subtree: true })));
    expect(dec(rows.get(ids.A)?.["budget_change_abs"])).toBe("300.0000");
  });

  it("sorts and pages by the change", async () => {
    const q = request({ compareTo: { baselineId }, sort: [{ key: "budget_change_abs", dir: "desc" }], limit: 2 });
    const c1 = compileQuery(q, PERIOD, TODAY);
    const p1 = pageOf(c1, await runAsApp(c1, { workspaceId: ws, userId: org.users.u1 }), 2);
    const c2 = compileQuery({ ...q, cursor: p1.nextCursor as string }, PERIOD, TODAY);
    const p2 = pageOf(c2, await runAsApp(c2, { workspaceId: ws, userId: org.users.u1 }), 2);
    expect([...p1.rows, ...p2.rows].map((r) => String(r["envelope_id"]))).toEqual([ids.C, ids.A, ids.B, ids.D]);
  });

  it("filters on the change, and refuses the change measures without compareTo", async () => {
    const grew = await run(request({ compareTo: { baselineId }, filter: { logic: "and", children: [{ field: { kind: "measure", key: "budget_change_abs" }, op: "gt", value: 0 }] } }));
    expect(grew.map((r) => String(r["envelope_id"])).sort()).toEqual([ids.A, ids.C].sort());
    expect(() => compileQuery(request({}), PERIOD, TODAY)).toThrow(/compareTo/);
  });
});
