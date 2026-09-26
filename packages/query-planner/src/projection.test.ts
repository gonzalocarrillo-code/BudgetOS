import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals, pageOf, type CompileOptions, type CompiledQuery } from "./index.js";
import { app, closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, seedNamedFixture, type FixtureOrg, type NamedFixture } from "./test-support/fixtures.js";

/**
 * Projection measures (ADR-030): the latest run per envelope, summed over the period, read by one
 * lateral per envelope; nothing read when no measure needs it or the workspace has no projections.
 */

let org: FixtureOrg;
let fx: NamedFixture;
let empty: string;

beforeAll(async () => {
  org = await createOrg();
  fx = await seedNamedFixture(org);
  empty = await createWorkspace(org);
  await insertEnvelope(org, empty, {
    name: "No projections",
    geo: "br",
    platform: "meta",
    status: "APPROVED",
    start: "2026-01-01",
    end: "2026-03-31",
    versions: [{ amount: "400.00", status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
    spend: [{ date: "2026-01-10", amount: "100.00" }],
  });
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const PROJECTION = ["budget", "actual", "projected", "variance_abs", "variance_pct", "projected_close_pct"];
const request = (workspaceId: string, over: Record<string, unknown> = {}) =>
  QueryRequest.parse({ workspaceId, period: { kind: "range", ...PERIOD }, limit: 1000, sort: [{ key: "name", dir: "asc" }], ...over });
const run = (c: CompiledQuery, workspaceId: string) => runAsApp(c, { workspaceId, userId: org.users.u1 });
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [String(r["name"]), r]));
const dec = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(4));

async function plan(c: CompiledQuery, workspaceId: string): Promise<string> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.org_id', $2, true), set_config('app.user_id', $3, true)`, [workspaceId, org.orgId, org.users.u1]);
    const r = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${c.sql}`, c.values);
    await client.query("COMMIT");
    return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
  } finally {
    client.release();
  }
}

describe("latest projection run", () => {
  it("a newer run that projects only after the period wins, so the envelope projects 0", async () => {
    const ws = await createWorkspace(org);
    const oldRun = randomUUID();
    const newRun = randomUUID();
    await insertEnvelope(org, ws, {
      name: "Later run",
      geo: "br",
      platform: "meta",
      status: "APPROVED",
      start: "2026-01-01",
      end: "2026-03-31",
      versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
      projections: [
        { date: "2026-02-15", value: "700", runId: oldRun, loadedAt: "2026-02-01T00:00:00Z" },
        { date: "2026-04-15", value: "50", runId: newRun, loadedAt: "2026-02-10T00:00:00Z" },
      ],
    });
    // Two in-period dates of the latest run add up; a run split over two loads is still one run.
    await insertEnvelope(org, ws, {
      name: "Split run",
      geo: "br",
      platform: "meta",
      status: "APPROVED",
      start: "2026-01-01",
      end: "2026-03-31",
      versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-05T00:00:00Z" }],
      projections: [
        { date: "2026-01-31", value: "999", runId: oldRun, loadedAt: "2026-02-01T00:00:00Z" },
        { date: "2026-02-28", value: "300", runId: newRun, loadedAt: "2026-02-10T00:00:00Z" },
        { date: "2026-03-31", value: "200", runId: newRun, loadedAt: "2026-02-10T00:05:00Z" },
        { date: "2026-04-30", value: "80", runId: newRun, loadedAt: "2026-02-10T00:05:00Z" },
      ],
    });
    // An unmatched projection (no envelope) never counts.
    await owner.query(
      `INSERT INTO projection_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id, loaded_at)
       VALUES ($1, NULL, '{}'::jsonb, '2026-03-01', 'spend', 5000, 5000, 'fixture_v1', '2026-03-31', 'fixture', $2, '2026-03-01T00:00:00Z')`,
      [ws, randomUUID()],
    );
    const rows = byName(await run(compileQuery(request(ws, { measures: PROJECTION }), PERIOD, TODAY), ws));
    expect(dec(rows["Later run"]?.["projected"])).toBe("0.0000");
    expect(dec(rows["Split run"]?.["projected"])).toBe("500.0000");
    expect(dec(rows["Split run"]?.["projected_close_pct"])).toBe("0.5000");
    const [totals] = await run(compileTotals(request(ws, { measures: PROJECTION }), PERIOD, TODAY), ws);
    expect(dec(totals?.["projected"])).toBe("500.0000");
  });

  it("the named fixture keeps its projections: E1 reads the newer run, E3 and E4 have none", async () => {
    const rows = byName(await run(compileQuery(request(fx.workspaceId, { measures: PROJECTION }), PERIOD, TODAY), fx.workspaceId));
    expect(Object.fromEntries(Object.entries(rows).map(([n, r]) => [n, dec(r["projected"])]))).toEqual({
      "BR Meta": "1300.0000",
      "SP Google": "2400.0000",
      "MX Meta": "0.0000",
      "DE TikTok": "0.0000",
      "Unassigned Meta": "900.0000",
    });
  });

  it("filters and sorts on projection measures, in rows and in totals", async () => {
    const filter = { logic: "and", children: [{ field: { kind: "measure", key: "projected_close_pct" }, op: "gt", value: 1 }] };
    const rows = await run(compileQuery(request(fx.workspaceId, { measures: PROJECTION, filter, sort: [{ key: "projected", dir: "desc" }] }), PERIOD, TODAY), fx.workspaceId);
    expect(rows.map((r) => r["name"])).toEqual(["SP Google", "Unassigned Meta"]);
    const [totals] = await run(compileTotals(request(fx.workspaceId, { measures: PROJECTION, filter }), PERIOD, TODAY), fx.workspaceId);
    expect(dec(totals?.["projected"])).toBe("3300.0000");
  });
});

describe("flat pages read projections after the LIMIT", () => {
  it("pages by cursor to the same rows and projections as one page", async () => {
    const all = await run(compileQuery(request(fx.workspaceId, { measures: PROJECTION, sort: [{ key: "budget", dir: "desc" }] }), PERIOD, TODAY), fx.workspaceId);
    const paged: Row[] = [];
    let cursor: string | null = null;
    do {
      const c = compileQuery(request(fx.workspaceId, { measures: PROJECTION, sort: [{ key: "budget", dir: "desc" }], limit: 2, ...(cursor ? { cursor } : {}) }), PERIOD, TODAY);
      const page = pageOf(c, await run(c, fx.workspaceId), 2);
      paged.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(all);
    expect(all.map((r) => [r["name"], dec(r["projected"]), dec(r["variance_abs"])])).toEqual([
      ["SP Google", "2400.0000", "400.0000"],
      ["BR Meta", "1300.0000", "-200.0000"],
      ["Unassigned Meta", "900.0000", "100.0000"],
      ["MX Meta", "0.0000", "-500.0000"],
      ["DE TikTok", "0.0000", null],
    ]);
  });

  it("joins projections once, over the page, unless the order or the filter reads them", async () => {
    const tail = compileQuery(request(fx.workspaceId, { measures: PROJECTION }), PERIOD, TODAY);
    expect(tail.sql).toContain("x.envelope_id = q.envelope_id");
    expect(await plan(tail, fx.workspaceId)).toMatch(/Nested Loop Left Join[\s\S]*-> {2}Limit/);
    const sorted = compileQuery(request(fx.workspaceId, { measures: PROJECTION, sort: [{ key: "variance_pct", dir: "asc" }] }), PERIOD, TODAY);
    expect(sorted.sql).not.toContain("x.envelope_id = q.envelope_id");
  });
});

describe("no projection work when none is needed", () => {
  it("does not read projection_fact when no requested measure depends on it", async () => {
    const c = compileQuery(request(fx.workspaceId, { measures: ["budget", "actual", "pace_index", "spend_to_date_pct"], groupBy: ["geo"], sort: [] }), PERIOD, TODAY);
    expect(c.sql).toContain("projection_fact");
    expect(await plan(c, fx.workspaceId)).not.toContain("projection_fact");
  });

  it("reads projection_fact once per envelope, not once per expression that uses `projected`", async () => {
    const c = compileQuery(request(fx.workspaceId, { measures: PROJECTION, groupBy: ["geo"], sort: [] }), PERIOD, TODAY);
    const p = await plan(c, fx.workspaceId);
    // One lateral (its partitions) plus the workspace-wide EXISTS: two scans of the Q1 partition.
    expect(p.match(/on projection_fact_202601/g)?.length).toBe(2);
  });

  it("hasProjections: false compiles projected to 0 without projection_fact, with the same results", async () => {
    const opts: CompileOptions = { hasProjections: false };
    for (const q of [request(empty, { measures: PROJECTION }), request(empty, { measures: PROJECTION, groupBy: ["geo"], sort: [] })]) {
      const without = compileQuery(q, PERIOD, TODAY, opts);
      expect(without.sql).not.toContain("projection_fact");
      expect(await run(without, empty)).toEqual(await run(compileQuery(q, PERIOD, TODAY), empty));
    }
    const t = compileTotals(request(empty, { measures: PROJECTION }), PERIOD, TODAY, opts);
    expect(t.sql).not.toContain("projection_fact");
    expect(await run(t, empty)).toEqual(await run(compileTotals(request(empty, { measures: PROJECTION }), PERIOD, TODAY), empty));
  });
});
