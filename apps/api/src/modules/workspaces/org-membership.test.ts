import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * Round 11 (PR 3): the org console manages who is in which workspace — `POST /org/people` invites
 * someone (always into one workspace with a role, D4) and `PUT /org/people/:id/workspaces/:wsId`
 * sets a person's direct roles there. Both are superadmin-only.
 */
const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ws = randomUUID();
const other = randomUUID();
const archived = randomUUID();
const superadmin = testUser("orgmem-super", randomUUID());
const admin = testUser("orgmem-admin", randomUUID());
const planner = testUser("orgmem-planner", randomUUID());

async function call(user: TestUser, method: Method, url: string, body?: unknown, requestId = `orgmem-${randomUUID()}`) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}

async function auditActions(requestId: string): Promise<string[]> {
  const rows = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId), orgId);
  return rows.map((r) => r.action);
}
/** outbox has no request_id column; the tests below read it as "rows added by this one call", via id watermarks. */
async function outboxWatermark(workspaceId: string): Promise<bigint> {
  const rows = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ id: bigint }>>(`SELECT coalesce(max(id), 0) AS id FROM outbox WHERE workspace_id = $1::uuid`, workspaceId), orgId);
  return rows[0]?.id ?? 0n;
}
async function outboxTopicsSince(workspaceId: string, sinceId: bigint): Promise<string[]> {
  const rows = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ topic: string }>>(`SELECT topic FROM outbox WHERE workspace_id = $1::uuid AND id > $2 ORDER BY id`, workspaceId, sinceId), orgId);
  return rows.map((r) => r.topic);
}

beforeAll(async () => {
  for (const [id, name] of [[orgId, "orgmem"], [otherOrgId, "orgmem-other"]] as const) await owner.organization.create({ data: { id, name } });
  for (const u of [superadmin, admin, planner]) await owner.user.create({ data: { id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` } });
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.createMany({
        data: [
          { id: ws, orgId, slug: `orgmem-${ws}`, name: "Primary", reportingCurrency: "USD" },
          { id: other, orgId, slug: `orgmem-${other}`, name: "Other", reportingCurrency: "USD" },
          { id: archived, orgId, slug: `orgmem-${archived}`, name: "Archived", reportingCurrency: "USD", status: "ARCHIVED" },
        ],
      });
    },
    orgId,
  );
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: superadmin.id, role: "ORG_ADMIN", createdBy: superadmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: superadmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: superadmin.id },
    ],
  });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, [ws, other, archived], orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: superadmin.id } });
  await owner.user.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  await owner.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await owner.$disconnect();
});

describe("org console membership (round 11, PR 3)", () => {
  it("1-2: a superadmin gives and then removes a role in a workspace the person didn't belong to; role cache clears immediately", async () => {
    const w0 = await outboxWatermark(other);
    const r1 = `orgmem-${randomUUID()}`;
    const give = await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${other}`, { roles: ["VIEWER"] }, r1);
    expect(give.status, JSON.stringify(give.body)).toBe(200);
    expect(give.body).toMatchObject({ userId: planner.id, workspaceId: other, roles: ["VIEWER"], added: ["VIEWER"], removed: [] });
    expect(await auditActions(r1)).toEqual(["role.assigned"]);
    const w1 = await outboxWatermark(other);
    expect(await outboxTopicsSince(other, w0)).toEqual(["access.changed"]);

    const worksNow = await h.call("GET", `/api/v1/workspaces/${other}/dimensions`, await h.mint(planner), { headers: { "x-workspace-id": other } });
    expect(worksNow.status).not.toBe(403);

    const r2 = `orgmem-${randomUUID()}`;
    const remove = await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${other}`, { roles: [] }, r2);
    expect(remove.status, JSON.stringify(remove.body)).toBe(200);
    expect(remove.body).toMatchObject({ roles: [], added: [], removed: ["VIEWER"] });
    expect(await auditActions(r2)).toEqual(["role.revoked"]);
    expect(await outboxTopicsSince(other, w1)).toEqual(["access.changed"]);

    const blockedNow = await h.call("GET", `/api/v1/workspaces/${other}/dimensions`, await h.mint(planner), { headers: { "x-workspace-id": other } });
    expect(blockedNow.status).toBe(403);
  });

  it("3: removing the only WORKSPACE_ADMIN of a workspace is refused", async () => {
    const res = await call(superadmin, "PUT", `/org/people/${admin.id}/workspaces/${ws}`, { roles: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ details: { lastAdmin: true } });
    const roles = await owner.roleAssignment.findMany({ where: { workspaceId: ws, principalType: "user", principalId: admin.id } });
    expect(roles.map((r) => r.role)).toEqual(["WORKSPACE_ADMIN"]);
  });

  it("4: changing roles keeps the original row's id (and scope) for a role that stays", async () => {
    await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${ws}`, { roles: ["PLANNER"] });
    const before = await owner.roleAssignment.findFirstOrThrow({ where: { workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER" } });
    const res = await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${ws}`, { roles: ["PLANNER", "APPROVER"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await owner.roleAssignment.findFirstOrThrow({ where: { workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER" } });
    expect(after.id).toBe(before.id);
    const roles = await owner.roleAssignment.findMany({ where: { workspaceId: ws, principalType: "user", principalId: planner.id } });
    expect(roles.map((r) => r.role).sort()).toEqual(["APPROVER", "PLANNER"]);
    await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${ws}`, { roles: ["PLANNER"] }); // restore
  });

  it("5: a workspace admin or planner cannot call either route", async () => {
    expect((await call(admin, "PUT", `/org/people/${planner.id}/workspaces/${ws}`, { roles: ["VIEWER"] })).status).toBe(403);
    expect((await call(planner, "PUT", `/org/people/${admin.id}/workspaces/${ws}`, { roles: ["VIEWER"] })).status).toBe(403);
    expect((await call(admin, "POST", "/org/people", { email: "x@orgmem.test", name: "X", workspaceId: ws })).status).toBe(403);
    expect((await call(planner, "POST", "/org/people", { email: "y@orgmem.test", name: "Y", workspaceId: ws })).status).toBe(403);
  });

  it("6: an archived workspace is 423, a deleted one 404, and another org's user is 404", async () => {
    const onArchived = await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${archived}`, { roles: ["VIEWER"] });
    expect(onArchived.status, JSON.stringify(onArchived.body)).toBe(423);

    const missingWs = randomUUID();
    expect((await call(superadmin, "PUT", `/org/people/${planner.id}/workspaces/${missingWs}`, { roles: ["VIEWER"] })).status).toBe(404);

    const foreigner = testUser("orgmem-foreign", randomUUID());
    await owner.user.create({ data: { id: foreigner.id, orgId: otherOrgId, email: foreigner.email, name: foreigner.sub } });
    expect((await call(superadmin, "PUT", `/org/people/${foreigner.id}/workspaces/${ws}`, { roles: ["VIEWER"] })).status).toBe(404);
    await owner.user.delete({ where: { id: foreigner.id } });
  });

  it("7: inviting creates the person and gives them the role; the same email again is created:false; another org's email is 409", async () => {
    const email = `new-${randomUUID()}@orgmem.test`;
    const r1 = `orgmem-${randomUUID()}`;
    const invite = await call(superadmin, "POST", "/org/people", { email, name: "New Person", workspaceId: ws, role: "PLANNER" }, r1);
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    expect(invite.body).toMatchObject({ email, created: true });
    const audited = await auditActions(r1);
    expect(audited).toContain("user.added");
    expect(audited).toContain("role.assigned");
    const roles = await owner.roleAssignment.findMany({ where: { workspaceId: ws, principalType: "user", principalId: invite.body["id"] as string } });
    expect(roles.map((r) => r.role)).toEqual(["PLANNER"]);

    const again = await call(superadmin, "POST", "/org/people", { email, name: "New Person", workspaceId: other, role: "VIEWER" });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({ email, created: false });

    const outsiderEmail = "someone@elsewhere-org.test";
    await owner.user.create({ data: { id: randomUUID(), orgId: otherOrgId, email: outsiderEmail, name: "Outsider" } });
    const conflict = await call(superadmin, "POST", "/org/people", { email: outsiderEmail, name: "Outsider", workspaceId: ws, role: "VIEWER" });
    expect(conflict.status).toBe(409);
  });

  it("8: GET /org/people marks a workspace reached only through a group as viaGroup", async () => {
    const groupId = randomUUID();
    const grouped = testUser("orgmem-grouped", randomUUID());
    await owner.user.create({ data: { id: grouped.id, orgId, email: grouped.email, name: grouped.sub, googleSub: `g-${grouped.sub}` } });
    await asOrgAdmin(
      owner,
      async (tx) => {
        await tx.group.create({ data: { id: groupId, orgId, googleGroup: `grp-${groupId}@orgmem.test`, name: "Group" } });
        await tx.groupMember.create({ data: { groupId, userId: grouped.id } });
      },
      orgId,
    );
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "group", principalId: groupId, role: "VIEWER", createdBy: superadmin.id } });

    const res = await call(superadmin, "GET", "/org/people");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    type People = { people: Array<{ id: string; workspaces: Array<{ workspaceId: string; viaGroup: boolean }> }> };
    const body = res.body as unknown as People;
    const person = body.people.find((p) => p.id === grouped.id);
    expect(person?.workspaces.find((w) => w.workspaceId === ws)).toMatchObject({ viaGroup: true });

    await owner.roleAssignment.deleteMany({ where: { workspaceId: ws, principalType: "group", principalId: groupId } });
    await asOrgAdmin(
      owner,
      async (tx) => {
        await tx.groupMember.deleteMany({ where: { groupId } });
        await tx.group.deleteMany({ where: { id: groupId } });
      },
      orgId,
    );
    await owner.user.delete({ where: { id: grouped.id } });
  });
});
