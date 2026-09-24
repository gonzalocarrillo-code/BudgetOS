import { randomUUID } from "node:crypto";
import { QueryRequest, type FilterGroupT, type Predicate } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals, metricRegistry, pageOf } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import {
  NAMES,
  PERIOD,
  TODAY,
  cleanupOrg,
  createOrg,
  createWorkspace,
  insertEnvelope,
  seedNamedFixture,
  type FixtureOrg,
  type NamedEnvelope,
  type NamedFixture,
} from "./test-support/fixtures.js";

/**
 * Regressions for defects in the spec §6 code (see the T-007 fixes PR). planner.test.ts is the
 * operator matrix; this file pins the behaviour that code got wrong.
 */

let decoy: FixtureOrg;
let org: FixtureOrg;
let fx: NamedFixture;

beforeAll(async () => {
  metricRegistry.set("cpa", { numerator: "spend", denominator: "kpi:conversions" });
  // Created first so a `LIMIT 1` lookup of the org-wide `geo` dimension would find this org's row.
  decoy = await createOrg();
  org = await createOrg();
  fx = await seedNamedFixture(org);
});

afterAll(async () => {
  metricRegistry.delete("cpa");
  if (org) await cleanupOrg(org);
  if (decoy) await cleanupOrg(decoy);
  await closePools();
});

function request(workspaceId: string, over: Record<string, unknown> = {}): QueryRequest {
  return QueryRequest.parse({ workspaceId, period: { kind: "range", ...PERIOD }, limit: 1000, ...over });
}
const run = (q: QueryRequest, userId: string | null = org.users.u1): Promise<Row[]> =>
  runAsApp(compileQuery(q, PERIOD, TODAY), { workspaceId: q.workspaceId, userId });
const where = (...children: Predicate[]): FilterGroupT => ({ logic: "and", children });
const namesFor = async (filter: FilterGroupT) =>
  (await run(request(fx.workspaceId, { filter }))).map((r) => String(r["name"])).sort();
const expected = (...keys: NamedEnvelope[]) => keys.map((k) => NAMES[k]).sort();
const eqDec = (a: unknown, b: string) => a !== null && a !== undefined && new Decimal(String(a)).equals(b);

describe("asOf reads superseded versions", () => {
  // E1: 1000 approved 01-05, 1200 approved 01-20, 1500 approved 02-10; the first two are SUPERSEDED now.
  const e1Budget = async (asOf?: string) => {
    const rows = await run(
      request(fx.workspaceId, {
        filter: where({ field: { kind: "attr", key: "name" }, op: "eq", value: NAMES.E1 }),
        ...(asOf ? { asOf } : {}),
      }),
    );
    return rows[0]?.["budget"] ?? null;
  };
  it("returns the approved amount at three timestamps", async () => {
    expect(eqDec(await e1Budget("2026-01-10T00:00:00Z"), "1000")).toBe(true);
    expect(eqDec(await e1Budget("2026-01-25T00:00:00Z"), "1200")).toBe(true);
    expect(eqDec(await e1Budget("2026-02-12T00:00:00Z"), "1500")).toBe(true);
    expect(await e1Budget("2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("keyset pagination", () => {
  it("never duplicates or skips rows when rows are inserted between pages", async () => {
    const ws = await createWorkspace(org);
    const originals: string[] = [];
    for (let i = 0; i < 7; i++) {
      const e = await insertEnvelope(org, ws, {
        name: `P${i}`,
        status: "APPROVED",
        start: "2026-01-01",
        end: "2026-03-31",
        versions: [{ amount: `${(i + 1) * 100}.00`, status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
      });
      originals.push(e.id);
    }
    originals.push((await insertEnvelope(org, ws, { name: "P-null", status: "DRAFT", start: "2026-01-01", end: "2026-03-31" })).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const q = request(ws, { sort: [{ key: "budget", dir: "desc" }], limit: 3, ...(cursor ? { cursor } : {}) });
      const c = compileQuery(q, PERIOD, TODAY);
      const result = pageOf(c, await runAsApp(c, { workspaceId: ws, userId: null }), q.limit);
      seen.push(...result.rows.map((r) => String(r["envelope_id"])));
      cursor = result.nextCursor;
      if (page === 0) {
        for (const amount of ["99999.00", "450.00", "1.00"]) {
          await insertEnvelope(org, ws, {
            name: `New ${amount}`,
            status: "APPROVED",
            start: "2026-01-01",
            end: "2026-03-31",
            versions: [{ amount, status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
          });
        }
      }
      page++;
    } while (cursor !== null && page < 20);

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of originals) expect(seen).toContain(id);
  });

  it("rejects unknown sort keys and malformed cursors", () => {
    expect(() => compileQuery(request(fx.workspaceId, { sort: [{ key: "budget; drop", dir: "asc" }] }), PERIOD, TODAY)).toThrowError(/unknown sort key/);
    expect(() => compileQuery(request(fx.workspaceId, { cursor: "not-a-cursor" }), PERIOD, TODAY)).toThrowError(/cursor/);
  });
});

describe("filter fixes", () => {
  it("mentions_user @me resolves from app.user_id", async () => {
    expect(await namesFor(where({ field: { kind: "attr", key: "mentions_user" }, op: "eq", value: "@me" }))).toEqual(expected("E2"));
  });

  it("within accepts the quarter unit", async () => {
    const f = where({ field: { kind: "attr", key: "created_at" }, op: "within", value: { unit: "quarter", amount: -1, anchor: "today" } });
    expect(await namesFor(f)).toEqual(expected("E1", "E2", "E3", "E5"));
  });

  it("a target actual predicate without targets[] binds only the parameters it uses", async () => {
    const f = where({ field: { kind: "target", metric: "cpa", field: "actual" }, op: "lt", value: 20 });
    expect(await namesFor(f)).toEqual(expected("E1"));
  });

  it("an org-wide dimension with the same key in another org is never used", async () => {
    expect(await namesFor(where({ field: { kind: "dimension", key: "geo" }, op: "eq", value: "br" }))).toEqual(expected("E1"));
    expect(await namesFor(where({ field: { kind: "dimension", key: "geo" }, op: "descends_from", value: "latam" }))).toEqual(
      expected("E1", "E2", "E3"),
    );
  });

  it("empty NOT group selects nothing", async () => {
    expect(await namesFor({ logic: "and", not: true, children: [] })).toEqual([]);
  });

  it("totals match the sum of envelope rows", async () => {
    const rows = await run(request(fx.workspaceId));
    const [t] = await runAsApp(compileTotals(request(fx.workspaceId), PERIOD, TODAY), { workspaceId: fx.workspaceId, userId: null });
    const sum = rows.reduce((s, r) => (r["budget"] === null ? s : s.plus(String(r["budget"]))), new Decimal(0));
    expect(eqDec(t?.["budget"], sum.toString())).toBe(true);
  });
});

describe("application role", () => {
  it("runs without JIT", async () => {
    const setting = await owner.query<{ c: string[] | null }>(`SELECT rolconfig AS c FROM pg_roles WHERE rolname = 'budget_app'`);
    expect(setting.rows[0]?.c ?? []).toContain("jit=off");
  });
  it("a random workspace id sees nothing", async () => {
    expect(await runAsApp(compileQuery(request(fx.workspaceId), PERIOD, TODAY), { workspaceId: randomUUID(), userId: null })).toEqual([]);
  });
});
