import { QueryRequest, type Predicate } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileTotals } from "./index.js";
import { closePools, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * T-10 (audit): with `subtree: true` each row's `actual` (and `projected`) already sums everything
 * under it (ADR-050: a parent reads against its own `budget`, but its spend is its own plus every
 * descendant's), so a filter that matches both a parent and one of its descendants must not sum the
 * descendant's spend twice — once on its own row, again inside the parent's subtree. `compileTotals`
 * now drops a matched row whose immediate parent is also matched; `budget` is unaffected (it was
 * never summed across the subtree) and keeps adding each matched row's own amount.
 *
 * Grandparent (100,000 budget, no own spend) > Parent (50,000, 2,000 spent) > Child (20,000, 3,000
 * spent). Real spend over the whole chain: 5,000, whichever contiguous (root-down) subset matches.
 */
let org: FixtureOrg;
let ws: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  const gp = await insertEnvelope(org, ws, { name: "Grandparent", parentId: null, status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "100000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }] });
  id["gp"] = gp.id;
  const p = await insertEnvelope(org, ws, { name: "Parent", parentId: gp.id, status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "50000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }], spend: [{ date: "2026-01-10", amount: "2000.00" }] });
  id["p"] = p.id;
  const c = await insertEnvelope(org, ws, { name: "Child", parentId: p.id, status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "20000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }], spend: [{ date: "2026-01-12", amount: "3000.00" }] });
  id["c"] = c.id;
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const LIVE: Predicate = { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" };
const totals = async (ids: string[]): Promise<Row> => {
  const q = QueryRequest.parse({
    workspaceId: ws,
    period: { kind: "range", ...PERIOD },
    limit: 10,
    measures: ["budget", "actual"],
    subtree: true,
    filter: { logic: "and", children: [LIVE, { field: { kind: "attr", key: "id" }, op: "in", value: ids }] },
  });
  const [t] = await runAsApp(compileTotals(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
  return t as Row;
};
const dec = (v: unknown) => new Decimal(String(v)).toFixed(2);

describe("subtree totals do not double count a matched descendant's spend (ADR-050, T-10)", () => {
  it("the whole chain matched: only the root's row counts — its own budget, the whole chain's spend once", async () => {
    const t = await totals([id["gp"] as string, id["p"] as string, id["c"] as string]);
    expect(dec(t["budget"])).toBe("100000.00"); // the grandparent's own amount, never summed across its subtree
    expect(dec(t["actual"])).toBe("5000.00"); // 2,000 + 3,000, counted once via the grandparent's subtree
  });

  it("a nested match (parent and child, grandparent excluded by the filter): the parent's subtree already holds the child's spend, so only the parent's row counts", async () => {
    const t = await totals([id["p"] as string, id["c"] as string]);
    expect(dec(t["budget"])).toBe("50000.00"); // the parent's own amount
    expect(dec(t["actual"])).toBe("5000.00"); // 2,000 + 3,000, counted once via the parent's subtree
  });

  it("only the leaf matched: its own subtree (itself)", async () => {
    const t = await totals([id["c"] as string]);
    expect(dec(t["budget"])).toBe("20000.00");
    expect(dec(t["actual"])).toBe("3000.00");
  });
});
