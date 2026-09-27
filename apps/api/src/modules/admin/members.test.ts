import { randomUUID } from "node:crypto";
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
  await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = $1::uuid`, ws);
  await owner.roleAssignment.deleteMany({ where: { OR: [{ workspaceId: ws }, { principalId: orgAdmin.id }] } });
  await owner.groupMember.deleteMany({ where: { groupId } });
  await owner.group.deleteMany({ where: { orgId } });
  await owner.user.deleteMany({ where: { orgId: { in: [orgId, otherOrg] } } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } });
  await owner.$disconnect();
});

describe("members", () => {
  it("lists the org's people and groups with their roles here; not other orgs", async () => {
    const res = await call(admin, "GET", `/workspaces/${ws}/members`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = res.body as unknown as Members;
    expect(m.users.map((u) => u.email).sort()).toEqual([admin.email, planner.email, orgAdmin.email].sort());
    expect(m.users.find((u) => u.id === orgAdmin.id)?.orgAdmin).toBe(true);
    expect(m.users.find((u) => u.id === planner.id)).toMatchObject({ signedIn: true, orgAdmin: false, roles: [{ role: "PLANNER" }] });
    expect(m.groups).toEqual([expect.objectContaining({ id: groupId, memberCount: 1, roles: [] })]);
    expect((await call(planner, "GET", `/workspaces/${ws}/members`)).status).toBe(403);
  });

  it("an org admin adds a person by email (once), who can be given a role before signing in", async () => {
    expect((await call(admin, "POST", `/workspaces/${ws}/members`, { email: "x@members.test", name: "X" })).status).toBe(403); // a workspace admin cannot
    const requestId = `members-${randomUUID()}`;
    const added = await call(orgAdmin, "POST", `/workspaces/${ws}/members`, { email: "  New.Person@Members.test ", name: "New Person" }, requestId);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ email: "new.person@members.test", created: true });
    expect(Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE request_id = $1 AND action = 'user.added'`, requestId))[0]?.n)).toBe(1);
    const again = await call(orgAdmin, "POST", `/workspaces/${ws}/members`, { email: "new.person@members.test", name: "Someone else" });
    expect(again.body).toMatchObject({ id: added.body["id"], created: false });
    expect((await call(orgAdmin, "POST", `/workspaces/${ws}/members`, { email: outsider.email, name: "x" })).status).toBe(409);

    const role = await call(admin, "POST", `/workspaces/${ws}/roles`, { principalType: "user", principalId: added.body["id"], role: "BUDGET_OWNER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "LATAM" }] } });
    expect(role.status, JSON.stringify(role.body)).toBeLessThan(300);
    const m = (await call(admin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(m.users.find((u) => u.email === "new.person@members.test")).toMatchObject({ signedIn: false, roles: [{ role: "BUDGET_OWNER" }] });
  });
});
