import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * EX-5 (ADR-0090) API: naming conventions are registry rows written by a data admin (source.manage);
 * a write re-matches the campaign facts at once (one audit_event + one facts.loaded outbox row);
 * the preview reads real campaign names; the rule list shows the three kinds, database references
 * coming from the sources' `budget_ref` columns.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ex5-admin", randomUUID());
const dataAdmin = testUser("ex5-data", randomUUID());
const viewer = testUser("ex5-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `ex5api-${++seq}-${orgId}`;
const env: Record<string, string> = {};
const runId = randomUUID();
const sourceId = randomUUID();

async function call(user: TestUser, method: Method, url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const actions = async (requestId: string) => (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId))).map((r) => r.action);
const outboxFor = async (id: string) => Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'facts.loaded' AND payload->>'namingConventionId' = $2`, ws, id)))[0]?.n ?? 0);
const factState = async (id: string) =>
  (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null; match_method: string | null; match_status: string | null }>>(`SELECT envelope_id::text, match_method, match_status FROM spend_fact WHERE id = $1::uuid`, id)))[0];

async function fact(dims: Record<string, string>, amount: string): Promise<string> {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, '2026-03-01', 'USD', $4::numeric, $4::numeric, 'test', $5::uuid, $6, $6)`,
      id,
      ws,
      JSON.stringify(dims),
      amount,
      runId,
      `ex5api-${id}`,
    ),
  );
  return id;
}

const convention = { delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: { FB: "meta" } }, { dimension: null, aliases: {} }] };

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex5-api" } });
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex5-${ws}`, name: "EX-5", reportingCurrency: "USD" } }));
  await owner.user.createMany({ data: [admin, dataAdmin, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: dataAdmin.id, role: "DATA_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: admin.id },
    ],
  });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await asAdmin(async (tx) => {
    for (const [key, values] of [["country", [["BR", "BR"]]], ["platform", [["meta", "meta"]]], ["campaign", [["c-1", "BR_FB_Q4"], ["c-2", "Brazil spring"]]]] as const) {
      const dim = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, admin.id);
      for (const [code, label] of values) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), dim, code, label);
    }
    env["brMeta"] = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'BR Meta', '{"country":"BR","platform":"meta"}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`,
      env["brMeta"],
      ws,
      admin.id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO data_source (id, workspace_id, kind, name, config, mapping) VALUES ($1::uuid, $2::uuid, 'bigquery', 'Warehouse', '{"kind":"bigquery","projectId":"proj-123","dataset":"d","table":"t"}'::jsonb, $3::jsonb)`,
      sourceId,
      ws,
      JSON.stringify({ kind: "spend", columns: { day: { role: "period_date" }, spend: { role: "amount", currency: "USD" }, budget_id: { role: "budget_ref" } } }),
    );
  });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [admin.id, dataAdmin.id, viewer.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("naming conventions", () => {
  let conventionId = "";
  let fits: string;
  let misfit: string;

  it("the preview parses the largest real campaign names (labels), or names typed in", async () => {
    fits = await fact({ campaign: "c-1" }, "30.00");
    misfit = await fact({ campaign: "c-2" }, "10.00");
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention })).status).toBe(403);
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["samples"]).toEqual([
      expect.objectContaining({ name: "BR_FB_Q4", campaign: "c-1", dimensionValues: { country: "BR", platform: "meta" }, problem: null }),
      expect.objectContaining({ name: "Brazil spring", campaign: "c-2", dimensionValues: null, problem: { kind: "parts", expected: 3, found: 1 } }),
    ]);
    // EX-6: TikTok is in the platform dictionary now; a token no dictionary knows is still unknown.
    const typed = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention, names: ["BR_Zzz_x"] });
    expect(typed.body["samples"]).toEqual([expect.objectContaining({ name: "BR_Zzz_x", campaign: null, dimensionValues: null, problem: { kind: "unknown_value", position: 2, dimension: "platform", value: "Zzz" } })]);
  });

  it("only a data admin writes one; its dimensions must exist", async () => {
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-conventions`, convention)).status).toBe(403);
    const unknown = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions`, { delimiter: "_", tokens: [{ dimension: "adset" }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body["details"]).toMatchObject({ missing: ["adset"] });
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions`, { delimiter: "_", tokens: [{ dimension: null }] })).status).toBe(422);
  });

  it("creating one re-matches the campaign facts at once; one audit_event + one facts.loaded", async () => {
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions`, convention, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    conventionId = String((res.body["convention"] as { id: string }).id);
    expect(res.body).toMatchObject({ convention: { delimiter: "_", tokens: convention.tokens }, rematch: { spend: 2, envelopeIds: [env["brMeta"]] } });
    expect(await factState(fits)).toEqual({ envelope_id: env["brMeta"], match_method: "naming", match_status: null });
    expect(await factState(misfit)).toEqual({ envelope_id: null, match_method: null, match_status: "name_mismatch" });
    expect(await actions(requestId)).toEqual(["naming_convention.created"]);
    expect(await outboxFor(conventionId)).toBe(1);
    const cov = await call(dataAdmin, "GET", `/workspaces/${ws}/match-coverage`);
    expect(cov.body["open"]).toEqual([expect.objectContaining({ campaign: "c-2", status: "unmatched", reason: "name_mismatch" })]);
  });

  it("the rule list shows the three kinds: campaign rules, conventions and the sources' budget reference columns", async () => {
    const list = await call(viewer, "GET", `/workspaces/${ws}/match-rules`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ rules: [], conventions: [{ id: conventionId, delimiter: "_" }], references: [{ sourceId, sourceName: "Warehouse", column: "budget_id" }] });
  });

  it("deleting it (soft) re-matches the facts without it", async () => {
    expect((await call(viewer, "DELETE", `/naming-conventions/${conventionId}`)).status).toBe(403);
    const requestId = rid();
    const res = await call(dataAdmin, "DELETE", `/naming-conventions/${conventionId}`, undefined, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ rematch: { spend: 2, envelopeIds: [env["brMeta"]] } });
    expect(await factState(fits)).toEqual({ envelope_id: null, match_method: null, match_status: null });
    expect(await factState(misfit)).toEqual({ envelope_id: null, match_method: null, match_status: null });
    expect(await actions(requestId)).toEqual(["naming_convention.deleted"]);
    expect(await outboxFor(conventionId)).toBe(2);
    const [row] = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ deleted_at: Date | null }>>(`SELECT deleted_at FROM naming_convention WHERE id = $1::uuid`, conventionId));
    expect(row?.deleted_at).not.toBeNull();
    expect((await call(dataAdmin, "DELETE", `/naming-conventions/${conventionId}`)).status).toBe(404);
  });
});
