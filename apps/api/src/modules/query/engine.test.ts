import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../common/tenant.js";
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
  await owner.workspace.create({ data: { id: ws, orgId, slug: `engine-${ws}`, name: "Engine", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: user.id, orgId, email: user.email, name: user.sub, googleSub: `g-${user.sub}` } });
  const env = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'Leaf', '{}'::jsonb, '2025-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`, env, ws, user.id);
  await owner.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, 1000, 1000, 'APPROVED', $3::uuid, '2025-01-01T00:00:00Z')`, v, env, user.id);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, env, v);
});

afterAll(async () => {
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, ws);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
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
    await owner.$executeRawUnsafe(`UPDATE workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{dataVersion}', to_jsonb(coalesce((settings->>'dataVersion')::int, 0) + 1)) WHERE id = $1::uuid`, ws);
    expect((await runQuery(app, auth(), body(period), now, { cache, warehouse: null })).engine).toBe("postgres");
  });
});

describe("routing helpers", () => {
  it("months spanned, the largest plan estimate, and what may be cached", () => {
    expect(monthsSpanned({ start: "2025-01-01", end: "2026-01-31" })).toBe(13);
    expect(monthsSpanned({ start: "2025-01-15", end: "2026-02-01" })).toBe(14);
    expect(maxPlanRows([{ Plan: { "Plan Rows": 10, Plans: [{ "Plan Rows": 250_000 }, { "Plan Rows": 3 }] } }])).toBe(250_000);
    const q = (filter: unknown) => QueryRequest.parse({ workspaceId: ws, period: { kind: "relative", preset: "current_year" }, filter });
    expect(cacheKey(q({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] }), 7, "2026-06-15")).toMatch(new RegExp(`^q:${ws}:7:2026-06-15:[0-9a-f]{64}$`));
    expect(cacheKey(q({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: "q4" }] }), 7, "2026-06-15")).toBeNull();
  });
});
