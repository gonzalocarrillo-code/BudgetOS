import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { asOrgAdmin } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../common/tenant.js";
import { outbox, withTenant } from "@budget/db";
import { appDb, ownerDb, testUser } from "../../test-support/harness.js";
import { MemoryQueryCache, cacheKey, maxPlanRows, monthsSpanned, type Row, type Warehouse } from "./queries/engine.js";
import { runQuery } from "./queries/run-query.js";

/**
 * ADR-042 (spec §6.2 routing rule): a heavy grouped query runs on the warehouse replica when one is
 * configured; the rest on Postgres; results are cached by data version and scoped query.
 */

const owner = ownerDb();
const app = appDb();
const orgId = randomUUID();
const ws = randomUUID();
const user = testUser("engine-planner", randomUUID());
const auth = (): AuthContext => ({ ctx: { workspaceId: ws, orgId, userId: user.id, isOrgAdmin: false, actorType: "user", requestId: `engine-${randomUUID()}` }, user: { id: user.id, orgId, email: user.email, name: user.sub }, isOrgAdmin: false, roles: ["PLANNER"], assignments: [{ role: "PLANNER", scope: {} }] });
const now = new Date("2026-06-15T12:00:00Z");

class FakeWarehouse implements Warehouse {
  readonly dataset = "acme.budget_os_test";
  readonly calls: string[] = [];
  async query(sql: string): Promise<Row[]> {
    this.calls.push(sql);
    return sql.includes("GROUP BY d0")
      ? [{ dim_region: "latam", lbl_region: "LATAM", budget: "900.00", actual: "450.00", leaf_count: 1, pending_count: 0 }]
      : [{ budget: "900.00", actual: "450.00", leaf_count: 1 }];
  }
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "engine" } });
  // W0-6: the owner has no BYPASSRLS; workspace and the raw envelope rows need the org-admin
  // tenant context real writes get from withTenant.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.create({ data: { id: ws, orgId, slug: `engine-${ws}`, name: "Engine", reportingCurrency: "USD" } });
      const env = randomUUID();
      const v = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'Leaf', '{}'::jsonb, '2025-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`, env, ws, user.id);
      await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, 1000, 1000, 'APPROVED', $3::uuid, '2025-01-01T00:00:00Z')`, v, env, user.id);
      await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, env, v);
    },
    orgId,
  );
  await owner.user.create({ data: { id: user.id, orgId, email: user.email, name: user.sub, googleSub: `g-${user.sub}` } });
});

afterAll(async () => {
  // W0-6: all tenant tables below need the org-admin context; workspace.deleteMany must come
  // after the rows referencing it are gone, so it stays last inside the same asOrgAdmin call.
  // workspace_data_version cascades (ON DELETE CASCADE) when the workspace row goes.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`, ws);
      await tx.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, ws);
      await tx.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, ws);
      await tx.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = $1::uuid`, ws);
      await tx.workspace.deleteMany({ where: { orgId } });
    },
    orgId,
  );
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

const body = (period: unknown, extra: Record<string, unknown> = {}) => ({ workspaceId: ws, period, groupBy: ["region"], measures: ["budget", "actual"], ...extra });

describe("query routing", () => {
  it("a grouped query over more than 13 months runs on the warehouse; a short one on Postgres", async () => {
    const warehouse = new FakeWarehouse();
    const long = await runQuery(app, auth(), body({ kind: "range", start: "2025-01-01", end: "2026-02-28" }), now, { cache: null, warehouse });
    expect(long.engine).toBe("warehouse");
    expect(long.rows[0]).toMatchObject({ key: "latam", measures: { budget: "900.00", actual: "450.00" } });
    expect(long.totals).toMatchObject({ budget: "900.00", leafCount: "1" });
    expect(warehouse.calls).toHaveLength(2);
    expect(warehouse.calls[0]).toContain("`acme.budget_os_test.spend_fact`");

    const short = await runQuery(app, auth(), body({ kind: "range", start: "2026-01-01", end: "2026-03-31" }), now, { cache: null, warehouse });
    expect(short.engine).toBe("postgres");
    expect(short.totals["budget"]).toBe("1000.00");
    expect(warehouse.calls).toHaveLength(2); // not called again
  });

  it("without a warehouse everything runs on Postgres; a shape BigQuery cannot answer stays on Postgres", async () => {
    const long = { kind: "range", start: "2025-01-01", end: "2026-02-28" };
    expect((await runQuery(app, auth(), body(long), now, { cache: null, warehouse: null })).engine).toBe("postgres");
    const warehouse = new FakeWarehouse();
    const tagged = await runQuery(app, auth(), body(long, { filter: { logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: "q4" }] } }), now, { cache: null, warehouse });
    expect(tagged.engine).toBe("postgres");
    expect(warehouse.calls).toHaveLength(0);
  });

  it("caches by data version: the same query is served from the cache until the data changes", async () => {
    const cache = new MemoryQueryCache();
    const period = { kind: "range", start: "2026-01-01", end: "2026-03-31" };
    expect((await runQuery(app, auth(), body(period), now, { cache, warehouse: null })).engine).toBe("postgres");
    const again = await runQuery(app, auth(), body(period), now, { cache, warehouse: null });
    expect(again.engine).toBe("cache");
    expect(again.totals["budget"]).toBe("1000.00");
    // W3-8 (ADR-0084): a write moves the version through its outbox row, at commit, as the app role.
    // An open (or rolled-back) write does not; a committed one does.
    const write = () => withTenant(app, auth().ctx, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { kind: "engine-test" } }));
    await expect(withTenant(app, auth().ctx, async (tx) => {
      await outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { kind: "engine-test" } });
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect((await runQuery(app, auth(), body(period), now, { cache, warehouse: null })).engine).toBe("cache");
    await write();
    const fresh = await runQuery(app, auth(), body(period), now, { cache, warehouse: null });
    expect(fresh.engine).toBe("postgres");
    expect(fresh.dataVersion).toBe(again.dataVersion + 1);
    expect((await runQuery(app, auth(), body(period), now, { cache, warehouse: null })).engine).toBe("cache");
  });
});

describe("fact retention routing (D-002)", () => {
  it("a period before factsPrunedBefore runs on the warehouse when it can, and is refused when it cannot", async () => {
    await asOrgAdmin(owner, (tx) => tx.$executeRawUnsafe(`UPDATE workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{factsPrunedBefore}', '"2025-06-01"') WHERE id = $1::uuid`, ws), orgId);
    try {
      const old = { kind: "range", start: "2025-03-01", end: "2025-03-31" };
      const warehouse = new FakeWarehouse();
      // A short grouped query would stay on Postgres; before the horizon it goes to the replica.
      expect((await runQuery(app, auth(), body(old), now, { cache: null, warehouse })).engine).toBe("warehouse");
      // No warehouse, or a flat query BigQuery does not answer: refused, never a silent gap.
      await expect(runQuery(app, auth(), body(old), now, { cache: null, warehouse: null })).rejects.toMatchObject({ code: "VALIDATION", details: { factsPrunedBefore: "2025-06-01" } });
      await expect(runQuery(app, auth(), body(old, { groupBy: [] }), now, { cache: null, warehouse })).rejects.toMatchObject({ code: "VALIDATION" });
      // From the horizon on, nothing changes.
      const hot = { kind: "range", start: "2025-06-01", end: "2025-06-30" };
      expect((await runQuery(app, auth(), body(hot), now, { cache: null, warehouse: null })).engine).toBe("postgres");
    } finally {
      await asOrgAdmin(owner, (tx) => tx.$executeRawUnsafe(`UPDATE workspace SET settings = settings - 'factsPrunedBefore' WHERE id = $1::uuid`, ws), orgId);
    }
  });
});

describe("routing helpers", () => {
  it("months spanned, the largest plan estimate, and what may be cached", () => {
    expect(monthsSpanned({ start: "2025-01-01", end: "2026-01-31" })).toBe(13);
    expect(monthsSpanned({ start: "2025-01-15", end: "2026-02-01" })).toBe(14);
    expect(maxPlanRows([{ Plan: { "Plan Rows": 10, Plans: [{ "Plan Rows": 250_000 }, { "Plan Rows": 3 }] } }])).toBe(250_000);
    const q = (filter: unknown) => QueryRequest.parse({ workspaceId: ws, period: { kind: "relative", preset: "current_year" }, filter });
    expect(cacheKey(q({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] }), 7, "2026-06-15")).toMatch(new RegExp(`^q2:${ws}:7:2026-06-15:[0-9a-f]{64}$`));
    expect(cacheKey(q({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: "q4" }] }), 7, "2026-06-15")).toBeNull();
    // ADR-062: pace counted through the data's last day is another answer; through today (or later) is the same one.
    const latam = q({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] });
    expect(cacheKey(latam, 7, "2026-06-15", "2026-05-31")).toMatch(new RegExp(`^q2:${ws}:7:2026-06-15~2026-05-31:[0-9a-f]{64}$`));
    expect(cacheKey(latam, 7, "2026-06-15", "2026-06-20")).toBe(cacheKey(latam, 7, "2026-06-15"));
  });
});

describe("demo exclusion (T-5)", () => {
  const demoOrgId = randomUUID();
  const demoWs = randomUUID();
  const pureWs = randomUUID();
  const demoUser = testUser("engine-demo", randomUUID());
  const authFor = (workspaceId: string): AuthContext => ({
    ctx: { workspaceId, orgId: demoOrgId, userId: demoUser.id, isOrgAdmin: false, actorType: "user", requestId: `engine-demo-${randomUUID()}` },
    user: { id: demoUser.id, orgId: demoOrgId, email: demoUser.email, name: demoUser.sub },
    isOrgAdmin: false,
    roles: ["PLANNER"],
    assignments: [{ role: "PLANNER", scope: {} }],
  });
  const demoAuth = () => authFor(demoWs);
  const pureAuth = () => authFor(pureWs);

  beforeAll(async () => {
    await owner.organization.create({ data: { id: demoOrgId, name: "engine-demo" } });
    // W0-6: the owner has no BYPASSRLS; workspace and the raw envelope/spend_fact rows need the
    // org-admin tenant context real writes get from withTenant.
    await asOrgAdmin(
      owner,
      async (tx) => {
        await tx.workspace.create({ data: { id: demoWs, orgId: demoOrgId, slug: `engine-demo-${demoWs}`, name: "Engine Demo", reportingCurrency: "USD" } });
        await tx.workspace.create({ data: { id: pureWs, orgId: demoOrgId, slug: `engine-demo-pure-${pureWs}`, name: "Engine Demo Pure", reportingCurrency: "USD" } });

        const real = randomUUID();
        const realV = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, demo) VALUES ($1::uuid, $2::uuid, 'Real', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now(), false)`, real, demoWs, demoUser.id);
        await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at, demo) VALUES ($1::uuid, $2::uuid, 1, 1000, 1000, 'APPROVED', $3::uuid, '2026-01-01T00:00:00Z', false)`, realV, real, demoUser.id);
        await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, real, realV);
        await tx.$executeRawUnsafe(
          `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, demo) VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-02-01', 'USD', 100, 100, 'fixture', $3::uuid, $4, false)`,
          demoWs,
          real,
          randomUUID(),
          randomUUID(),
        );

        const demoEnv = randomUUID();
        const demoV = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, demo) VALUES ($1::uuid, $2::uuid, 'Demo', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now(), true)`, demoEnv, demoWs, demoUser.id);
        await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at, demo) VALUES ($1::uuid, $2::uuid, 1, 500, 500, 'APPROVED', $3::uuid, '2026-01-01T00:00:00Z', true)`, demoV, demoEnv, demoUser.id);
        await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, demoEnv, demoV);
        await tx.$executeRawUnsafe(
          `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, demo) VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-02-01', 'USD', 50, 50, 'fixture', $3::uuid, $4, true)`,
          demoWs,
          demoEnv,
          randomUUID(),
          randomUUID(),
        );

        // A second, pure-demo workspace (the Slack sandbox / a fresh onboarding workspace): no real
        // budget at all. Demo rows must show up here with no includeDemo plumbing from the caller.
        const pureDemoEnv = randomUUID();
        const pureDemoV = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, demo) VALUES ($1::uuid, $2::uuid, 'Demo', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now(), true)`, pureDemoEnv, pureWs, demoUser.id);
        await tx.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at, demo) VALUES ($1::uuid, $2::uuid, 1, 500, 500, 'APPROVED', $3::uuid, '2026-01-01T00:00:00Z', true)`, pureDemoV, pureDemoEnv, demoUser.id);
        await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, pureDemoEnv, pureDemoV);
        await tx.$executeRawUnsafe(
          `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, demo) VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-02-01', 'USD', 50, 50, 'fixture', $3::uuid, $4, true)`,
          pureWs,
          pureDemoEnv,
          randomUUID(),
          randomUUID(),
        );
      },
      demoOrgId,
    );
    await owner.user.create({ data: { id: demoUser.id, orgId: demoOrgId, email: demoUser.email, name: demoUser.sub, googleSub: `g-${demoUser.sub}` } });
  });

  afterAll(async () => {
    // W0-6: all tenant tables below need the org-admin context; workspace.deleteMany must come
    // after the rows referencing it are gone, so it stays last inside the same asOrgAdmin call.
    await asOrgAdmin(
      owner,
      async (tx) => {
        for (const w of [demoWs, pureWs]) {
          await tx.$executeRawUnsafe(`UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`, w);
          await tx.$executeRawUnsafe(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, w);
          await tx.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, w);
          await tx.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, w);
        }
        await tx.workspace.deleteMany({ where: { orgId: demoOrgId } });
      },
      demoOrgId,
    );
    await owner.user.deleteMany({ where: { orgId: demoOrgId } });
    await owner.organization.delete({ where: { id: demoOrgId } });
  });

  it("/query on a workspace with demo + real data returns only real totals by default, and both with includeDemo", async () => {
    const period = { kind: "range", start: "2026-01-01", end: "2026-12-31" };
    const onlyReal = await runQuery(app, demoAuth(), { workspaceId: demoWs, period, groupBy: [], measures: ["budget", "actual"] }, now, { cache: null, warehouse: null });
    expect(onlyReal.totals["budget"]).toBe("1000.00");
    expect(onlyReal.totals["actual"]).toBe("100.00");
    expect(onlyReal.rows.map((r) => r.path.join("/"))).toEqual(["Real"]);

    const withDemo = await runQuery(app, demoAuth(), { workspaceId: demoWs, period, groupBy: [], measures: ["budget", "actual"], includeDemo: true }, now, { cache: null, warehouse: null });
    expect(withDemo.totals["budget"]).toBe("1500.00");
    expect(withDemo.totals["actual"]).toBe("150.00");
    expect(withDemo.rows.map((r) => r.path.join("/")).sort()).toEqual(["Demo", "Real"]);
  });

  it("/query on a pure-demo workspace (no real budget yet) includes the demo rows automatically, with no includeDemo needed", async () => {
    const period = { kind: "range", start: "2026-01-01", end: "2026-12-31" };
    const res = await runQuery(app, pureAuth(), { workspaceId: pureWs, period, groupBy: [], measures: ["budget", "actual"] }, now, { cache: null, warehouse: null });
    expect(res.totals["budget"]).toBe("500.00");
    expect(res.totals["actual"]).toBe("50.00");
    expect(res.rows.map((r) => r.path.join("/"))).toEqual(["Demo"]);
  });
});
