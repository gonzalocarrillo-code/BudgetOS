import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-027 API: POST /workspaces/:ws/query (flat rows carry the version an edit is based on; the
 * caller's scope is ANDed in) and saved views (private to the owner, workspace-wide only with
 * view.share_workspace; each write is one audit_event + one outbox row).
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t027-planner", randomUUID());
const other = testUser("t027-other", randomUUID());
const scoped = testUser("t027-scoped", randomUUID());
const admin = testUser("t027-admin", randomUUID());
const orgAdmin = testUser("t027-org", randomUUID());
const X = { "x-workspace-id": ws };
type Res = { status: number; body: Record<string, unknown> };
const call = async (u: TestUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Res> => h.call(method, `/api/v1${url}`, await h.mint(u), { headers: X, ...(body === undefined ? {} : { body }) });
const period = { kind: "range", start: "2026-01-01", end: "2026-12-31" };
const env: Record<string, { id: string; version: string }> = {};

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t027" } });
  // W0-6: the owner has no BYPASSRLS; workspace, dimension/dimension_value and approval_policy need
  // the org-admin tenant context real writes get from withTenant.
  const region = randomUUID();
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.create({ data: { id: ws, orgId, slug: `t027-${ws}`, name: "T-027", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
      for (const code of ["latam", "emea"]) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
      await tx.approvalPolicy.create({ data: { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 1, conditions: {}, chain: [], blockSelfApproval: true } });
    },
    orgId,
  );
  await owner.user.createMany({ data: [planner, other, scoped, admin, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  const latam = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] };
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: other.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scoped.id, role: "VIEWER", scope: latam, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  h = await startHarness();
  for (const [key, amount] of [["latam", "700.00"], ["emea", "300.00"]] as const) {
    const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name: key, dimensionValues: { region: key }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount, ownerId: planner.id });
    await call(planner, "POST", `/envelopes/${String(created.body["id"])}/submit`, { versionId: created.body["draftVersionId"] });
    env[key] = { id: String(created.body["id"]), version: String(created.body["draftVersionId"]) };
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context.
  await deleteWorkspaceForTests(owner, ws, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
    },
    orgId,
  );
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("POST /workspaces/:ws/query (T-027)", () => {
  it("flat rows carry the version an edit is based on; totals come from the planner", async () => {
    const res = await call(planner, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period, measures: ["budget"], sort: [{ key: "name", dir: "asc" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = res.body["rows"] as Array<{ envelopeId: string; versionId: string; measures: { budget: string } }>;
    expect(rows.map((r) => [r.envelopeId, r.versionId, r.measures.budget])).toEqual([
      [env["emea"]?.id, env["emea"]?.version, "300.00"],
      [env["latam"]?.id, env["latam"]?.version, "700.00"],
    ]);
    expect(res.body["totals"]).toMatchObject({ budget: "1000.00" });
  });

  it("a scoped caller's query is cut to their scope, grouped or flat", async () => {
    const res = await call(scoped, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period, groupBy: ["region"], measures: ["budget"] });
    expect((res.body["rows"] as Array<{ key: string }>).map((r) => r.key)).toEqual(["latam"]);
    expect(res.body["totals"]).toMatchObject({ budget: "700.00" });
  });
});

describe("saved views (T-027)", () => {
  it("private to the owner; one audit_event and one outbox row per write", async () => {
    const created = await call(planner, "POST", `/workspaces/${ws}/saved-views`, { name: "LATAM tree", definition: { view: "tree", groupBy: ["region"] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body["id"]);
    expect(((await call(planner, "GET", `/workspaces/${ws}/saved-views?screen=explorer`)).body as unknown as Array<{ name: string }>).map((v) => v.name)).toEqual(["LATAM tree"]);
    expect((await call(other, "GET", `/workspaces/${ws}/saved-views`)).body).toEqual([]);
    expect((await call(other, "PATCH", `/saved-views/${id}`, { name: "mine now" })).status).toBe(404);
    expect((await call(planner, "PATCH", `/saved-views/${id}`, { name: "LATAM only" })).body).toMatchObject({ name: "LATAM only" });
    expect((await call(planner, "DELETE", `/saved-views/${id}`)).body).toEqual({ id, deleted: true });
    const audits = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'saved_view' AND entity_id = $1::uuid ORDER BY occurred_at`, id), orgId);
    expect(audits.map((a) => a.action)).toEqual(["saved_view.created", "saved_view.updated", "saved_view.deleted"]);
    const [n] = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'view.changed' AND payload->>'savedViewId' = $1`, id), orgId);
    expect(Number(n?.n)).toBe(3);
  });

  it("a workspace view needs view.share_workspace; everyone then sees it", async () => {
    expect((await call(planner, "POST", `/workspaces/${ws}/saved-views`, { name: "Everyone", definition: {}, visibility: "workspace" })).status).toBe(403);
    const shared = await call(admin, "POST", `/workspaces/${ws}/saved-views`, { name: "Everyone", definition: { view: "pivot" }, visibility: "workspace" });
    expect(shared.status).toBe(201);
    expect(((await call(other, "GET", `/workspaces/${ws}/saved-views`)).body as unknown as Array<{ name: string }>).map((v) => v.name)).toEqual(["Everyone"]);
    expect((await call(other, "DELETE", `/saved-views/${String(shared.body["id"])}`)).status).toBe(403);
  });
});
