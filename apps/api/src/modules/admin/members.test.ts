import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
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
  for (const u of [admin, planner, orgAdmin]) await owner.user.create({ data: { id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` } });
  await owner.user.create({ data: { id: outsider.id, orgId: otherOrg, email: outsider.email, name: outsider.sub, googleSub: `g-${outsider.sub}` } });
  // W0-6: workspace, app_group and app_group_member have no owner_bootstrap policy; they need the
  // org-admin tenant context real writes get from withTenant, with the real org id for the exact
  // org_id match app_group/app_group_member require. The group member row's own app_user row must
  // already exist (its EXISTS check also needs the matching org_id), so users are created first.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.create({ data: { id: ws, orgId, slug: `members-${ws}`, name: "Members", reportingCurrency: "USD" } });
      await tx.group.create({ data: { id: groupId, orgId, googleGroup: `leads-${groupId}@members.test`, name: "Leads" } });
      await tx.groupMember.create({ data: { groupId, userId: planner.id } });
    },
    orgId,
  );
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: admin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: admin.id },
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
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.groupMember.deleteMany({ where: { groupId } });
      await tx.group.deleteMany({ where: { orgId } });
    },
    orgId,
  );
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await owner.user.deleteMany({ where: { orgId: { in: [orgId, otherOrg] } } });
  await owner.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } });
  await owner.$disconnect();
});

describe("members (ORG-005 / ADR-088: a workspace's people list is scoped to that workspace, for every caller)", () => {
  it("a workspace admin sees the people and groups with a role here; a superadmin sees only their own role here plus whoever else has one; never other orgs", async () => {
    const res = await call(admin, "GET", `/workspaces/${ws}/members`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = res.body as unknown as Members;
    expect(m.users.map((u) => u.email).sort()).toEqual([admin.email, planner.email].sort());
    expect(m.users.find((u) => u.id === planner.id)).toMatchObject({ signedIn: true, orgAdmin: false, roles: [{ role: "PLANNER" }] });
    expect(m.groups).toEqual([]); // the Leads group has no role here
    // ADR-088: the superadmin has no role of their own in `ws`, so they do not appear in it either.
    const all = (await call(orgAdmin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(all.users.map((u) => u.email).sort()).toEqual([admin.email, planner.email].sort());
    expect(all.groups).toEqual([]);
    expect((await call(planner, "GET", `/workspaces/${ws}/members`)).status).toBe(403);
  });

  it("ADR-088: a superadmin's view of workspace A never includes someone who only holds a role in workspace B", async () => {
    const ws2 = randomUUID();
    const sandboxOnly = testUser("members-sandbox", randomUUID());
    await owner.user.create({ data: { id: sandboxOnly.id, orgId, email: sandboxOnly.email, name: sandboxOnly.sub, googleSub: `g-${sandboxOnly.sub}` } });
    await asOrgAdmin(owner, (tx) => tx.workspace.create({ data: { id: ws2, orgId, slug: `members-${ws2}`, name: "Sandbox", reportingCurrency: "USD" } }), orgId);
    await owner.roleAssignment.createMany({
      data: [
        { id: randomUUID(), workspaceId: ws2, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
        { id: randomUUID(), workspaceId: ws2, principalType: "user", principalId: sandboxOnly.id, role: "PLANNER", createdBy: admin.id },
      ],
    });
    const byAdmin = (await call(admin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(byAdmin.users.find((u) => u.id === sandboxOnly.id)).toBeUndefined();
    const byOrgAdmin = (await call(orgAdmin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(byOrgAdmin.users.find((u) => u.id === sandboxOnly.id)).toBeUndefined();
    await deleteWorkspaceForTests(owner, ws2, orgId);
    await owner.user.delete({ where: { id: sandboxOnly.id } });
  });

  it("a workspace admin adds someone by email with a role here (Viewer unless chosen); once; never another org's email", async () => {
    const requestId = `members-${randomUUID()}`;
    const added = await call(admin, "POST", `/workspaces/${ws}/members`, { email: "  New.Person@Members.test ", name: "New Person" }, requestId);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ email: "new.person@members.test", created: true, role: "VIEWER" });
    const audited = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId), orgId);
    expect(audited.map((a) => a.action).sort()).toEqual(["role.assigned", "user.added"]);
    const again = await call(admin, "POST", `/workspaces/${ws}/members`, { email: "new.person@members.test", name: "Someone else", role: "BUDGET_OWNER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "LATAM" }] } });
    expect(again.body).toMatchObject({ id: added.body["id"], created: false, role: "BUDGET_OWNER" });
    expect((await call(admin, "POST", `/workspaces/${ws}/members`, { email: outsider.email, name: "x" })).status).toBe(409);
    expect((await call(planner, "POST", `/workspaces/${ws}/members`, { email: "y@members.test", name: "Y" })).status).toBe(403);

    const m = (await call(admin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(m.users.find((u) => u.email === "new.person@members.test")).toMatchObject({ signedIn: false, roles: [{ role: "VIEWER" }, { role: "BUDGET_OWNER" }] });
    // ADR-088: a superadmin adding with no role chosen now gets Viewer too, so the person shows up here.
    const bare = await call(orgAdmin, "POST", `/workspaces/${ws}/members`, { email: "later@members.test", name: "Later" });
    expect(bare.body).toMatchObject({ created: true, role: "VIEWER" });
    const afterBare = (await call(admin, "GET", `/workspaces/${ws}/members`)).body as unknown as Members;
    expect(afterBare.users.find((u) => u.email === "later@members.test")).toMatchObject({ roles: [{ role: "VIEWER" }] });
  });

  // W3-3 (audit I-19): assignRole()'s "duplicate" check is SELECT-then-INSERT; two concurrent
  // assignments of a role the principal does not have yet both pass it.
  // role_assignment_unique_scoped (20261015010000_partial_unique_constraints) refuses the second
  // row; assign-role.ts maps the resulting P2002 to the same 409 the sequential check already gives.
  it("W3-3 (audit I-19): two concurrent assignments of the same new role make exactly one row", async () => {
    const [a, b] = await Promise.all([
      call(admin, "POST", `/workspaces/${ws}/roles`, { principalType: "user", principalId: planner.id, role: "FINANCE" }),
      call(admin, "POST", `/workspaces/${ws}/roles`, { principalType: "user", principalId: planner.id, role: "FINANCE" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await owner.roleAssignment.count({ where: { workspaceId: ws, principalType: "user", principalId: planner.id, role: "FINANCE" } })).toBe(1);
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
