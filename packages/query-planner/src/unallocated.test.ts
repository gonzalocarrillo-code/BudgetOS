import { QueryRequest, type Predicate } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * ADR-059: with `unallocated`, every live budget counts for the part of its amount it has not
 * split into live children, so a pivot adds up to the top-level budgets, whatever it groups by.
 * The tree the product owner built (2026-09-29), in thousands:
 *
 * | budget        | parent        | platform | geo   | amount | children     | holds |
 * |---------------|---------------|----------|-------|--------|--------------|-------|
 * | Media         | —             | —        | —     | 150    | 100 + 50     | 0     |
 * | Search        | Media         | google   | —     | 100    | 10           | 90    |
 * | Social        | Media         | meta     | —     | 50     | 20 (+ Q2, archived) | 30 |
 * | Search LATAM  | Search        | google   | br    | 10     | 5            | 5     |
 * | Search SP     | Search LATAM  | google   | br_sp | 5      | 5            | 0     |
 * | Consumer      | Search SP     | google   | br_sp | 5      | —            | 5     |
 * | Social LATAM  | Social        | meta     | br    | 20     | —            | 20    |
 * | Social Q2     | Social        | meta     | mx    | 7      | outside Q1   | —     |
 * | Social old    | Social        | meta     | mx    | 9      | archived     | —     |
 *
 * Live leaves (Consumer, Social LATAM) add up to 25; the top-level budget is 150.
 */
let org: FixtureOrg;
let ws: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  const env = async (name: string, amount: string, parent: string | null, platform: string | null, geo: string | null, extra: { start?: string; end?: string; spend?: string } = {}) => {
    const e = await insertEnvelope(org, ws, {
      name,
      parentId: parent === null ? null : (id[parent] as string),
      platform,
      geo,
      status: "APPROVED",
      start: extra.start ?? PERIOD.start,
      end: extra.end ?? PERIOD.end,
      versions: [{ amount, status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
      ...(extra.spend ? { spend: [{ date: "2026-01-20", amount: extra.spend }] } : {}),
    });
    id[name] = e.id;
  };
  await env("Media", "150000.00", null, null, null);
  // Spend booked on a parent directly (before it was split) is its own, and counts once.
  await env("Search", "100000.00", "Media", "google", null, { spend: "1000.00" });
  await env("Social", "50000.00", "Media", "meta", null);
  await env("Search LATAM", "10000.00", "Search", "google", "br");
  await env("Search SP", "5000.00", "Search LATAM", "google", "br_sp");
  await env("Consumer", "5000.00", "Search SP", "google", "br_sp", { spend: "2000.00" });
  await env("Social LATAM", "20000.00", "Social", "meta", "br", { spend: "500.00" });
  await env("Social Q2", "7000.00", "Social", "meta", "mx", { start: "2026-04-01", end: "2026-06-30" });
  await env("Social old", "9000.00", "Social", "meta", "mx");
  await owner.query(`UPDATE envelope SET status = 'ARCHIVED' WHERE id = $1`, [id["Social old"]]);
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const LIVE: Predicate = { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" };
const LEAF: Predicate = { field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true };
const MEASURES = ["budget", "budget_in_period", "actual", "remaining"];
const request = (over: Record<string, unknown>) => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 1000, measures: MEASURES, filter: { logic: "and", children: [LIVE] }, ...over });
const run = (q: QueryRequest) => runAsApp(compileQuery(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
const totals = async (q: QueryRequest) => (await runAsApp(compileTotals(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 }))[0] as Row;
const k = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).div(1000).toFixed(2));

describe("unallocated (ADR-059)", () => {
  it("leaves alone lose what parents have not split: the gap the owner saw", async () => {
    const t = await totals(request({ filter: { logic: "and", children: [LIVE, LEAF] } }));
    expect(k(t["budget"])).toBe("25.00");
  });

  it("totals add up to the top-level budgets, and spend on a parent counts once", async () => {
    const t = await totals(request({ unallocated: true }));
    expect([k(t["budget"]), k(t["budget_in_period"]), k(t["actual"]), k(t["remaining"])]).toEqual(["150.00", "150.00", "3.50", "146.50"]);
    // Leaves: the live envelopes with no live child in the period.
    expect(Number(t["leaf_count"])).toBe(2);
  });

  it("each flat row holds its own unsplit amount; fully split parents drop out", async () => {
    const rows = await run(request({ unallocated: true, sort: [{ key: "name", dir: "asc" }] }));
    expect(rows.map((r) => [r["name"], k(r["budget"]), Number(r["child_count"])])).toEqual([
      ["Consumer", "5.00", 0],
      ["Search", "90.00", 1],
      ["Search LATAM", "5.00", 1],
      ["Social", "30.00", 1],
      ["Social LATAM", "20.00", 0],
    ]);
  });

  it("every grouping partitions the same 150", async () => {
    const byPlatform = await run(request({ unallocated: true, groupBy: ["platform"] }));
    expect(Object.fromEntries(byPlatform.map((r) => [r["dim_platform"] ?? "none", k(r["budget"])]))).toEqual({ google: "100.00", meta: "50.00" });
    const byGeo = await run(request({ unallocated: true, groupBy: ["geo"] }));
    expect(Object.fromEntries(byGeo.map((r) => [r["dim_geo"] ?? "none", k(r["budget"])]))).toEqual({ br: "25.00", br_sp: "5.00", none: "120.00" });
  });

  it("a filter keeps each budget's own holding: the search branch is its own 100", async () => {
    const t = await totals(request({ unallocated: true, filter: { logic: "and", children: [LIVE, { field: { kind: "dimension", key: "platform" }, op: "eq", value: "google" }] } }));
    expect(k(t["budget"])).toBe("100.00");
  });

  it("a period that holds only the Q2 child counts it alone", async () => {
    const q2 = { start: "2026-04-01", end: "2026-06-30" };
    const q = QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...q2 }, limit: 1000, measures: ["budget"], filter: { logic: "and", children: [LIVE] }, unallocated: true });
    const [t] = await runAsApp(compileTotals(q, q2, "2026-05-01"), { workspaceId: ws, userId: org.users.u1 });
    expect(k((t as Row)["budget"])).toBe("7.00");
  });

  it("is not a structure query", () => {
    expect(() => compileQuery(request({ unallocated: true, subtree: true }), PERIOD, TODAY)).toThrow(/subtree/);
  });
});
