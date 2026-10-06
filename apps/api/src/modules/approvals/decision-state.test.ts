import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-029 API: GET /approvals/:id says whether the caller may decide the current step and, if not,
 * why (the decision bar's disabled reason), and names the requester and every decider.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t029-planner", randomUUID());
const approver = testUser("t029-approver", randomUUID());
const viewer = testUser("t029-viewer", randomUUID());
const orgAdmin = testUser("t029-org", randomUUID());
const X = { "x-workspace-id": ws };
const call = async (u: TestUser, method: "GET" | "POST", url: string, body?: unknown) => h.call(method, `/api/v1${url}`, await h.mint(u), { headers: X, ...(body === undefined ? {} : { body }) });

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t029" } });
  // W0-6: the owner has no BYPASSRLS; workspace, dimension/dimension_value and approval_policy need
  // the org-admin tenant context real writes get from withTenant.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.create({ data: { id: ws, orgId, slug: `t029-${ws}`, name: "T-029", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
      const region = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
      await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, 'latam', 'latam')`, randomUUID(), region);
      await tx.approvalPolicy.create({ data: { id: randomUUID(), workspaceId: ws, name: "One approver", priority: 1, conditions: {}, chain: [{ role: "APPROVER", minApprovals: 1, timeoutHours: 48 }], blockSelfApproval: true } });
    },
    orgId,
  );
  await owner.user.createMany({ data: [planner, approver, viewer, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: `Name ${u.sub}`, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: approver.id, role: "APPROVER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  h = await startHarness();
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

describe("GET /approvals/:id decision state (T-029)", () => {
  it("who may decide, why not, and who everyone is", async () => {
    const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name: "Brazil", dimensionValues: { region: "latam" }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount: "900.00", ownerId: planner.id });
    const submitted = await call(planner, "POST", `/envelopes/${String(created.body["id"])}/submit`, { versionId: created.body["draftVersionId"] });
    const requestId = String(submitted.body["requestId"]);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    expect((await call(planner, "GET", `/approvals/${requestId}`)).body["decision"]).toEqual({ canDecide: false, reason: "You made this change; someone else must approve it", stepRole: "APPROVER" });
    expect((await call(viewer, "GET", `/approvals/${requestId}`)).body["decision"]).toEqual({ canDecide: false, reason: "Step 1 needs an approver", stepRole: "APPROVER" });
    const before = await call(approver, "GET", `/approvals/${requestId}`);
    expect(before.body["decision"]).toEqual({ canDecide: true, reason: null, stepRole: "APPROVER" });
    expect(before.body["people"]).toEqual({ [planner.id]: `Name ${planner.sub}` });

    expect((await call(approver, "POST", `/approvals/${requestId}/decisions`, { decision: "approve", comment: "Fits the Q plan" })).status).toBe(201);
    const after = await call(approver, "GET", `/approvals/${requestId}`);
    expect(after.body["decision"]).toMatchObject({ canDecide: false, reason: "The request is approved" });
    expect(after.body["people"]).toEqual({ [planner.id]: `Name ${planner.sub}`, [approver.id]: `Name ${approver.sub}` });
    const list = await call(approver, "GET", `/approvals?status=APPROVED`);
    expect((list.body["rows"] as Array<{ requestedByName: string }>)[0]?.requestedByName).toBe(`Name ${planner.sub}`);
  });
});
