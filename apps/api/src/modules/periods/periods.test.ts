import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { runQuery } from "../query/queries/run-query.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * Product feedback 7 (ADR-041): what a quarter is is the workspace's own calendar. Generate a 4-4-5
 * year, add custom partitions, and every query's "this quarter" follows the rows; a period with a
 * closure keeps its dates.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("t041p-admin", randomUUID());
const X = { "x-workspace-id": ws };
let env = "";

async function call(user: TestUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, requestId = `periods-${randomUUID()}`) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const auditCount = async (requestId: string) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1`, requestId))[0]?.n);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "periods" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `periods-${ws}`, name: "Periods", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.create({ data: { id: admin.id, orgId, email: admin.email, name: admin.sub, googleSub: `g-${admin.sub}` } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id } });
  // One leaf with spend on 1 April: calendar Q2, but 4-4-5 Q1.
  env = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'Leaf', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`, env, ws, admin.id);
  await owner.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, 1000, 1000, 'APPROVED', $3::uuid, '2026-01-01T00:00:00Z')`, v, env, admin.id);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, env, v);
  await owner.$executeRawUnsafe(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash) VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-04-01', 'USD', 40, 40, 'csv', $3::uuid, $4)`,
    ws, env, randomUUID(), randomUUID(),
  );
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  for (const sql of [
    `DELETE FROM period_closure WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, period_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM fiscal_period WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  // W3-11 (audit I-32): audit_event.workspace_id is now a FK to workspace(id); append-only, so the trigger is disabled for this cleanup only.
  await owner.$executeRawUnsafe("ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable");
  await owner.$executeRawUnsafe("DELETE FROM audit_event WHERE org_id = $1::uuid", orgId);
  await owner.$executeRawUnsafe("ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable");
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("the fiscal calendar", () => {
  it("generates a 4-4-5 year, adds a custom partition, and refuses clashes", async () => {
    const requestId = `periods-${randomUUID()}`;
    const gen = await call(admin, "POST", `/workspaces/${ws}/periods/generate`, { fiscalYear: 2026, pattern: "445" }, requestId);
    expect(gen.status, JSON.stringify(gen.body)).toBe(201);
    expect((gen.body["created"] as string[]).length).toBe(17); // FY + 4 quarters + 12 months
    expect(await auditCount(requestId)).toBe(1);
    expect((await call(admin, "POST", `/workspaces/${ws}/periods/generate`, { fiscalYear: 2026, pattern: "445" })).body["created"]).toEqual([]);

    const bf = await call(admin, "POST", `/workspaces/${ws}/periods`, { key: "Black Friday 2026", start: "2026-11-20", end: "2026-11-30" });
    expect(bf.status, JSON.stringify(bf.body)).toBe(201);
    expect((await call(admin, "POST", `/workspaces/${ws}/periods`, { key: "Black Friday 2026", start: "2026-11-01", end: "2026-11-02" })).status).toBe(409);
    expect((await call(admin, "POST", `/workspaces/${ws}/periods`, { key: "Extra Q", kind: "quarter", start: "2026-03-01", end: "2026-05-31" })).status).toBe(409); // overlaps 2026-Q1/Q2
    expect((await call(admin, "POST", `/workspaces/${ws}/periods`, { key: "Backwards", start: "2026-05-01", end: "2026-04-01" })).status).toBe(422);

    const list = (await call(admin, "GET", `/workspaces/${ws}/periods`)).body as unknown as Array<{ key: string; kind: string; start: string; end: string }>;
    expect(list.find((p) => p.key === "2026-Q1")).toMatchObject({ kind: "quarter", start: "2026-01-01", end: "2026-04-01" });
    expect(list.find((p) => p.key === "Black Friday 2026")).toMatchObject({ kind: "custom" });
  });

  it("'this quarter' follows the calendar in every query: the 1 April spend is in 4-4-5 Q1", async () => {
    const auth: AuthContext = { ctx: { workspaceId: ws, orgId, userId: admin.id, isOrgAdmin: false, actorType: "user", requestId: "periods" }, user: { id: admin.id, orgId, email: admin.email, name: admin.sub }, isOrgAdmin: false, roles: ["WORKSPACE_ADMIN"], assignments: [{ role: "WORKSPACE_ADMIN", scope: {} }] };
    const q = (period: unknown) => runQuery(app, auth, { workspaceId: ws, period, measures: ["actual"], limit: 10 }, new Date("2026-03-15T12:00:00Z"));
    expect((await q({ kind: "relative", preset: "current_quarter" })).totals["actual"]).toBe("40.00");
    expect((await q({ kind: "fiscal", key: "Black Friday 2026" })).totals["actual"]).toBe("0.00");
    expect((await q({ kind: "range", start: "2026-01-01", end: "2026-03-31" })).totals["actual"]).toBe("0.00"); // a calendar quarter would miss it
  });

  it("a period with a closure keeps its dates; one budgets are aligned to cannot be deleted", async () => {
    const list = (await call(admin, "GET", `/workspaces/${ws}/periods`)).body as unknown as Array<{ id: string; key: string }>;
    const q1 = list.find((p) => p.key === "2026-Q1")?.id as string;
    const p02 = list.find((p) => p.key === "FY2026-P02")?.id as string;
    const bf = list.find((p) => p.key === "Black Friday 2026")?.id as string;
    await owner.$executeRawUnsafe(`INSERT INTO period_closure (id, workspace_id, period_id, status, closed_by, registry_version, bq_table, variance_summary) VALUES ($1::uuid, $2::uuid, $3::uuid, 'closed', $4::uuid, '{}'::jsonb, 'memory', '{}'::jsonb)`, randomUUID(), ws, q1, admin.id);
    expect((await call(admin, "PATCH", `/periods/${q1}`, { end: "2026-03-31" })).status).toBe(409);
    expect((await call(admin, "DELETE", `/periods/${q1}`)).status).toBe(409);
    await owner.$executeRawUnsafe(`UPDATE envelope SET period_id = $2::uuid WHERE id = $1::uuid`, env, p02);
    expect((await call(admin, "DELETE", `/periods/${p02}`)).status).toBe(409);

    const moved = await call(admin, "PATCH", `/periods/${bf}`, { start: "2026-11-19" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ start: "2026-11-19", end: "2026-11-30" });
    const requestId = `periods-${randomUUID()}`;
    expect((await call(admin, "DELETE", `/periods/${bf}`, undefined, requestId)).status).toBe(200);
    expect(await auditCount(requestId)).toBe(1);
    const listed = (await call(admin, "GET", `/workspaces/${ws}/periods`)).body as unknown as Array<{ key: string; closure: { status: string } | null }>;
    expect(listed.find((p) => p.key === "2026-Q1")?.closure?.status).toBe("closed");
    expect(listed.some((p) => p.key === "Black Friday 2026")).toBe(false);
  });

  it("generating a year refuses when a period exists with other dates (no gaps, no overlaps)", async () => {
    // FY2025 on calendar months first, then 4-4-5 over it: 2025-Q1 differs.
    expect((await call(admin, "POST", `/workspaces/${ws}/periods/generate`, { fiscalYear: 2025, pattern: "calendar" })).status).toBe(201);
    const res = await call(admin, "POST", `/workspaces/${ws}/periods/generate`, { fiscalYear: 2025, pattern: "445" });
    expect(res.status).toBe(409);
    expect(String(res.body["message"])).toMatch(/2025-Q1.*other dates/);
    expect(await owner.fiscalPeriod.count({ where: { workspaceId: ws, key: { startsWith: "FY2025-P" } } })).toBe(0); // nothing created
  });

  it("the fiscal year start month is set by an admin", async () => {
    const res = await call(admin, "PATCH", `/workspaces/${ws}/fiscal-year`, { startMonth: 7 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await owner.workspace.findUniqueOrThrow({ where: { id: ws } })).fiscalYearStartMonth).toBe(7);
    expect((await call(admin, "PATCH", `/workspaces/${ws}/fiscal-year`, { startMonth: 13 })).status).toBe(422);
  });
});
