import { QueryRequest, type FilterGroupT, type Predicate } from "@budget/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * T-11 (audit): GET /workspaces/:ws/pacing and MCP's query_budgets counted archived budgets because
 * neither filters `status`. The planner now excludes `status = 'ARCHIVED'` by default — unless the
 * caller's own filter says something about status, which is its own choice to make (ADR-016's
 * `status neq ARCHIVED` live-leaves filter, or a filter that asks for archived rows on purpose).
 */
let org: FixtureOrg;
let ws: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  const live = await insertEnvelope(org, ws, { name: "Live", parentId: null, status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }] });
  id["live"] = live.id;
  const old = await insertEnvelope(org, ws, { name: "Old", parentId: null, status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "500.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }] });
  id["old"] = old.id;
  await owner.query(`UPDATE envelope SET status = 'ARCHIVED' WHERE id = $1`, [old.id]);
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const names = async (filter: FilterGroupT): Promise<string[]> => {
  const q = QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget"], filter });
  const rows = await runAsApp(compileQuery(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
  return rows.map((r) => String(r["name"])).sort();
};
const total = async (filter: FilterGroupT): Promise<Row> => {
  const q = QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget"], filter });
  const [t] = await runAsApp(compileTotals(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
  return t as Row;
};
const idIn = (): Predicate => ({ field: { kind: "attr", key: "id" }, op: "in", value: [id["live"] as string, id["old"] as string] });

describe("archived envelopes are excluded by default (T-11)", () => {
  it("a filter that never mentions status leaves archived rows out, like GET /pacing and MCP's query_budgets", async () => {
    const filter: FilterGroupT = { logic: "and", children: [idIn()] };
    expect(await names(filter)).toEqual(["Live"]);
    expect(String((await total(filter))["budget"])).toBe("1000.00");
  });

  it("an empty filter (the whole workspace) still excludes archived rows by default", async () => {
    expect(await names({ logic: "and", children: [] })).toEqual(["Live"]);
  });

  it("an asOf read (a historical reconstruction) still counts a budget archived since then — status is present-tense, asOf is not", async () => {
    const filter: FilterGroupT = { logic: "and", children: [idIn()] };
    const q = QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget"], filter, asOf: "2026-01-10T00:00:00.000Z" });
    const rows = await runAsApp(compileQuery(q, PERIOD, TODAY), { workspaceId: ws, userId: org.users.u1 });
    expect(rows.map((r) => String(r["name"])).sort()).toEqual(["Live", "Old"]);
  });

  it("a filter that mentions status makes its own choice: ADR-016's live-leaves filter still excludes archived", async () => {
    const live: FilterGroupT = { logic: "and", children: [idIn(), { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] };
    expect(await names(live)).toEqual(["Live"]);
  });

  it("a filter that asks for archived rows gets them", async () => {
    const archivedOnly: FilterGroupT = { logic: "and", children: [idIn(), { field: { kind: "attr", key: "status" }, op: "eq", value: "ARCHIVED" }] };
    expect(await names(archivedOnly)).toEqual(["Old"]);
  });
});
