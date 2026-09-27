import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateSupported, compileAggregate, compileAggregateTotals, compileQuery, compileTotals, pageOf } from "./index.js";
import { closePools, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, seedNamedFixture, type FixtureOrg, type NamedFixture } from "./test-support/fixtures.js";

/**
 * ADR-042: the set-based planner returns exactly what the per-envelope planner returns — same
 * rows, same measures, same order and cursor — for every shape it supports; the rest go to the
 * per-envelope planner.
 */

let org: FixtureOrg;
let fx: NamedFixture;

beforeAll(async () => {
  org = await createOrg();
  fx = await seedNamedFixture(org);
});
afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const MEASURES = ["budget", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct"];
/** Numbers compared as decimals to 12 places (ratio digits may differ past that); everything else as text. */
const norm = (rows: Row[]) =>
  rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(String(v)) ? new Decimal(String(v)).toDecimalPlaces(12).toString() : String(v)])),
  );

async function both(body: Record<string, unknown>, period = PERIOD, opts: { hasProjections?: boolean } = {}) {
  const q = QueryRequest.parse({ workspaceId: fx.workspaceId, period: { kind: "range", ...period }, measures: MEASURES, ...body });
  expect(aggregateSupported(q, opts), JSON.stringify(body)).toBe(true);
  const tenant = { workspaceId: fx.workspaceId, userId: org.users.u1 };
  if (q.groupBy.length === 0) {
    const [a] = await runAsApp(compileAggregateTotals(q, period, TODAY, opts), tenant);
    const [e] = await runAsApp(compileTotals(q, period, TODAY, opts), tenant);
    return { got: norm([a as Row]), want: norm([e as Row]) };
  }
  const a = compileAggregate(q, period, TODAY, opts);
  const e = compileQuery(q, period, TODAY, opts);
  expect(a.orderKeys).toEqual(e.orderKeys);
  return { got: norm(pageOf(a, await runAsApp(a, tenant), q.limit).rows), want: norm(pageOf(e, await runAsApp(e, tenant), q.limit).rows), a, e, q };
}

describe("set-based planner == per-envelope planner", () => {
  it.each([
    ["one dimension", { groupBy: ["geo"] }],
    ["two dimensions", { groupBy: ["geo", "platform"] }],
    ["a dimension filter", { groupBy: ["platform"], filter: { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "descends_from", value: "br" }] } }],
    ["an attr filter", { groupBy: ["geo"], filter: { logic: "or", children: [{ field: { kind: "attr", key: "status" }, op: "eq", value: "APPROVED" }, { field: { kind: "dimension", key: "platform" }, op: "is_empty" }] } }],
    ["sorted by budget", { groupBy: ["platform"], sort: [{ key: "budget", dir: "desc" }] }],
    ["as of an earlier instant", { groupBy: ["geo"], asOf: "2026-01-25T00:00:00.000Z" }],
    ["totals", {}],
    ["totals with a filter", { filter: { logic: "and", children: [{ field: { kind: "dimension", key: "platform" }, op: "eq", value: "meta" }] } }],
  ])("%s", async (_name, body) => {
    const { got, want } = await both(body as Record<string, unknown>);
    expect(got).toEqual(want);
  });

  it("a period that starts and ends mid-month (partial months from the daily facts), and without projections", async () => {
    const mid = { start: "2026-01-10", end: "2026-03-20" };
    for (const opts of [{}, { hasProjections: false }]) {
      const { got, want } = await both({ groupBy: ["geo", "platform"] }, mid, opts);
      expect(got).toEqual(want);
    }
  });

  it("pages with the same cursor", async () => {
    const first = await both({ groupBy: ["geo"], limit: 2 });
    expect(first.got).toEqual(first.want);
    const cursor = pageOf(first.e!, await runAsApp(first.e!, { workspaceId: fx.workspaceId, userId: org.users.u1 }), 2).nextCursor;
    expect(cursor).not.toBeNull();
    const second = await both({ groupBy: ["geo"], limit: 2, cursor });
    expect(second.got).toEqual(second.want);
  });

  it("leaves measure filters, KPI targets and flat pages to the per-envelope planner", () => {
    const q = (body: Record<string, unknown>) => QueryRequest.parse({ workspaceId: fx.workspaceId, period: { kind: "range", ...PERIOD }, ...body });
    expect(aggregateSupported(q({ groupBy: ["geo"], filter: { logic: "and", children: [{ field: { kind: "measure", key: "budget" }, op: "gt", value: 10 }] } }))).toBe(false);
    expect(aggregateSupported(q({ groupBy: ["geo"], targets: ["cpa"] }))).toBe(false);
    expect(aggregateSupported(q({ groupBy: ["geo"] }), { groupDates: true })).toBe(false);
    expect(aggregateSupported(q({ groupBy: ["geo"] }))).toBe(true);
  });
});
