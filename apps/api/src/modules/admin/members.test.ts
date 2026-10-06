import { randomUUID } from "node:crypto";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * The Roles page's API: the org's people and groups with their roles in this workspace, and adding
 * a person by email so a role can be given before they first sign in.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const otherOrg = randomUUID();
const ws = randomUUID();
const admin = testUser("members-admin", randomUUID());
const planner = testUser("members-planner", randomUUID());
const outsider = testUser("members-outsider", randomUUID());
const orgAdmin = testUser("members-org", randomUUID());
const groupId = randomUUID();

async function call(user: TestUser, method: "GET" | "POST", url: string, body?: unknown, requestId = `members-${randomUUID()}`) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { "x-workspace-id": ws, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
type Members = { users: Array<{ id: string; email: string; signedIn: boolean; orgAdmin: boolean; roles: Array<{ role: string }> }>; groups: Array<{ id: string; memberCount: number; roles: Array<{ role: string }> }> };

beforeAll(async () => {
  for (const [id, name] of [[orgId, "members"], [otherOrg, "other"]] as const) await owner.organization.create({ data: { id, name } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `members-${ws}`, name: "Members", reportingCurrency: "USD" } });
  for (const u of [admin, planner, orgAdmin]) await owner.user.create({ data: { id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` } });
  await owner.user.create({ data: { id: outsider.id, orgId: otherOrg, email: outsider.email, name: outsider.sub, googleSub: `g-${outsider.sub}` } });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: admin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: admin.id },
    ],
  });
  await owner.group.create({ data: { id: groupId, orgId, googleGroup: `leads-${groupId}@members.test`, name: "Leads" } });
  await owner.groupMember.create({ data: { groupId, userId: planner.id } });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  await deleteWorkspaceForTests(owner, ws);
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await owner.groupMember.deleteMany({ where: { groupId } });
  await owner.group.deleteMany({ where: { orgId } });
  await owner.user.deleteMany({ where: { orgId: { in: [orgId, otherOrg] } } });
  await owner.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } });
  await owner.$disconnect();
});

describe("members (ORG-005: a workspace admin sees and adds only their workspace's people)", () => {
  it("a workspace admin sees the people and groups with a role here; a superadmin sees the whole org; never other orgs", async () => {
    const res = await call(admin, "GET", `/workspaces/${ws}/members`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = res.body as unknown as Members;
    expect(m.users.map((u) => u.email).sort()).toEqual([admin.email, planner.email].sort());
    expect(m.users.find((u) => u.id === planner.id)).toMatchObject({ signedIn: true, orgAdmin: false, roles: [{ role: "PLANNER" }] });
    expect(m.groups).toEqual([]); // the Leads group has no role here
    const all = (await call(orgAdmin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(all.users.map((u) => u.email).sort()).toEqual([admin.email, planner.email, orgAdmin.email].sort());
    expect(all.users.find((u) => u.id === orgAdmin.id)?.orgAdmin).toBe(true);
    expect(all.groups).toEqual([expect.objectContaining({ id: groupId, memberCount: 1, roles: [] })]);
    expect((await call(planner, "GET", `/workspaces/${ws}/members`)).status).toBe(403);
  });

  it("a workspace admin adds someone by email with a role here (Viewer unless chosen); once; never another org's email", async () => {
    const requestId = `members-${randomUUID()}`;
    const added = await call(admin, "POST", `/workspaces/${ws}/members`, { email: "  New.Person@Members.test ", name: "New Person" }, requestId);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ email: "new.person@members.test", created: true, role: "VIEWER" });
    const audited = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId);
    expect(audited.map((a) => a.action).sort()).toEqual(["role.assigned", "user.added"]);
    const again = await call(admin, "POST", `/workspaces/${ws}/members`, { email: "new.person@members.test", name: "Someone else", role: "BUDGET_OWNER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "LATAM" }] } });
    expect(again.body).toMatchObject({ id: added.body["id"], created: false, role: "BUDGET_OWNER" });
    expect((await call(admin, "POST", `/workspaces/${ws}/members`, { email: outsider.email, name: "x" })).status).toBe(409);
    expect((await call(planner, "POST", `/workspaces/${ws}/members`, { email: "y@members.test", name: "Y" })).status).toBe(403);

    const m = (await call(admin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(m.users.find((u) => u.email === "new.person@members.test")).toMatchObject({ signedIn: false, roles: [{ role: "VIEWER" }, { role: "BUDGET_OWNER" }] });
    // A superadmin may add someone with no role yet, to give one later.
    const bare = await call(orgAdmin, "POST", `/workspaces/${ws}/members`, { email: "later@members.test", name: "Later" });
    expect(bare.body).toMatchObject({ created: true, role: null });
  });

  it("a workspace keeps at least one admin", async () => {
    const roles = (await call(admin, "GET", `/workspaces/${ws}/roles`)).body as unknown as { rows?: Array<{ id: string; role: string }> } | Array<{ id: string; role: string }>;
    const list = Array.isArray(roles) ? roles : (roles.rows ?? []);
    const only = list.find((r) => r.role === "WORKSPACE_ADMIN");
    expect(only).toBeDefined();
    const res = await h.call("DELETE", `/api/v1/roles/${only?.id ?? ""}`, await h.mint(admin), { headers: { "x-workspace-id": ws } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ details: { lastAdmin: true } });
  });
});
