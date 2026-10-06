import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { deleteWorkspaceForTests, purgeWorkspace } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRetentionDays } from "./lifecycle.js";
import { appDb as appDbClient, ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * ADR-052 done-when: only a superadmin archives, restores, deletes and undeletes a workspace; an
 * archived workspace is hidden from its members and read-only for superadmins (423 on writes); a
 * delete needs an archived workspace and its exact name; the purge removes the workspace's rows and
 * keeps its audit trail; superadmin actions are marked in audit_event.actor_context.
 */
const owner = ownerDb();
const app = appDbClient();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const other = randomUUID();
const superadmin = testUser("life-super", randomUUID());
const admin = testUser("life-admin", randomUUID());
const planner = testUser("life-planner", randomUUID());

async function call(user: TestUser, method: Method, url: string, body?: unknown, workspace: string | null = ws) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { ...(workspace ? { headers: { "x-workspace-id": workspace } } : {}), ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "lifecycle" } });
  for (const u of [superadmin, admin, planner]) await owner.user.create({ data: { id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` } });
  // W0-6: workspace and tag have no owner_bootstrap policy; they need the org-admin tenant context
  // real writes get from withTenant, with the real org id for workspace's exact org_id match.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.createMany({ data: [
        { id: ws, orgId, slug: `life-${ws.slice(0, 8)}`, name: "Acme LATAM", reportingCurrency: "USD" },
        { id: other, orgId, slug: `other-${other.slice(0, 8)}`, name: "Other", reportingCurrency: "USD" },
      ] });
      await tx.tag.create({ data: { id: randomUUID(), workspaceId: ws, name: "doomed", color: "#1868d8", createdBy: admin.id } });
    },
    orgId,
  );
  await owner.roleAssignment.createMany({ data: [
    { id: randomUUID(), workspaceId: null, principalType: "user", principalId: superadmin.id, role: "ORG_ADMIN", createdBy: superadmin.id },
    { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: superadmin.id },
    { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: superadmin.id },
    { id: randomUUID(), workspaceId: other, principalType: "user", principalId: admin.id, role: "PLANNER", createdBy: superadmin.id },
  ] });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  // W3-11 (audit I-32): deletes every row that FKs to these workspaces (and the workspace rows
  // themselves), in the same order `purgeWorkspace` validates against production (ws may already
  // be purged by the test above; every statement here is a no-op for rows already gone).
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context.
  await deleteWorkspaceForTests(owner, [ws, other], orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: superadmin.id } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.deleteMany({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("workspace lifecycle (ADR-052)", () => {
  it("WORKSPACE_RETENTION_DAYS: rejects 0 and NaN, defaults to 30, accepts >= 7", () => {
    expect(() => parseRetentionDays("0")).toThrow("Invalid WORKSPACE_RETENTION_DAYS");
    expect(() => parseRetentionDays("abc")).toThrow("Invalid WORKSPACE_RETENTION_DAYS");
    expect(parseRetentionDays(undefined)).toBe(30);
    expect(parseRetentionDays("45")).toBe(45);
    expect(parseRetentionDays("7")).toBe(7);
    expect(() => parseRetentionDays("6")).toThrow("Invalid WORKSPACE_RETENTION_DAYS");
  });

  it("lists the org's workspaces for superadmins only, with admins and counts", async () => {
    expect((await call(admin, "GET", "/workspaces", undefined, null)).status).toBe(403);
    const res = await call(superadmin, "GET", "/workspaces", undefined, null);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acme = (res.body["workspaces"] as Array<{ id: string; status: string; members: number; admins: Array<{ id: string }> }>).find((w) => w.id === ws);
    expect(acme).toMatchObject({ status: "ACTIVE", members: 2, admins: [{ id: admin.id }] });
  });

  it("archive: members lose it, a superadmin reads it but cannot write, restore brings it back", async () => {
    expect((await call(admin, "PATCH", `/workspaces/${ws}`, { status: "ARCHIVED" })).status).toBe(403); // a workspace admin cannot
    const archived = await call(superadmin, "PATCH", `/workspaces/${ws}`, { status: "ARCHIVED", reason: "Client paused" });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    expect((await call(planner, "GET", `/workspaces/${ws}/tags`)).status).toBe(403);
    const me = (await call(admin, "GET", "/me", undefined, null)).body as { workspaces: Array<{ workspaceId: string }> };
    expect(me.workspaces.map((w) => w.workspaceId)).toEqual([other]);
    const sm = (await call(superadmin, "GET", "/me", undefined, null)).body as { isSuperadmin: boolean; archivedWorkspaces: Array<{ workspaceId: string }> };
    expect(sm.isSuperadmin).toBe(true);
    expect(sm.archivedWorkspaces.map((w) => w.workspaceId)).toContain(ws);

    expect((await call(superadmin, "GET", `/workspaces/${ws}/tags`)).status).toBe(200);
    const write = await call(superadmin, "POST", `/workspaces/${ws}/tags`, { name: "late" });
    expect(write.status).toBe(423);

    expect((await call(superadmin, "PATCH", `/workspaces/${ws}`, { status: "ACTIVE" })).status).toBe(200);
    expect((await call(planner, "GET", `/workspaces/${ws}/tags`)).status).toBe(200);
    const audit = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ action: string; actor_context: string | null }>>(`SELECT action, actor_context FROM audit_event WHERE workspace_id = $1::uuid AND action LIKE 'workspace.%' ORDER BY occurred_at`, ws), orgId);
    expect(audit).toEqual([{ action: "workspace.archived", actor_context: "superadmin" }, { action: "workspace.restored", actor_context: "superadmin" }]);
  });

  it("delete: only archived, only with the exact name; undelete within the window; the purge keeps the audit trail", async () => {
    expect((await call(superadmin, "DELETE", `/workspaces/${ws}`, { confirmName: "Acme LATAM", reason: "done" })).status).toBe(409); // not archived
    await call(superadmin, "PATCH", `/workspaces/${ws}`, { status: "ARCHIVED" });
    expect((await call(superadmin, "DELETE", `/workspaces/${ws}`, { confirmName: "acme latam", reason: "done" })).status).toBe(422);
    const deleted = await call(superadmin, "DELETE", `/workspaces/${ws}`, { confirmName: "Acme LATAM", reason: "Contract over" });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((await call(superadmin, "GET", `/workspaces/${ws}/tags`)).status).toBe(403); // gone, even for a superadmin
    expect(((await call(superadmin, "GET", "/workspaces", undefined, null)).body["workspaces"] as Array<{ id: string }>).map((w) => w.id)).not.toContain(ws);

    expect((await call(superadmin, "POST", `/workspaces/${ws}/undelete`)).status).toBe(200);
    const back = await asOrgAdmin(owner, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: ws } }), orgId);
    expect(back).toMatchObject({ status: "ARCHIVED", deletedAt: null, slug: `life-${ws.slice(0, 8)}` });

    await call(superadmin, "DELETE", `/workspaces/${ws}`, { confirmName: "Acme LATAM", reason: "Contract over" });
    const counts = await purgeWorkspace(app, { workspaceId: ws, orgId });
    expect(counts["tag"]).toBe(1);
    expect(counts["role_assignment"]).toBe(2);
    expect(await asOrgAdmin(owner, (tx) => tx.tag.count({ where: { workspaceId: ws } }), orgId)).toBe(0);
    expect((await asOrgAdmin(owner, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: ws } }), orgId)).purgedAt).not.toBeNull();
    const kept = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid`, ws), orgId);
    expect(Number(kept[0]?.n)).toBeGreaterThan(4);
    expect((await call(superadmin, "POST", `/workspaces/${ws}/undelete`)).status).toBe(409); // purged: no way back
    expect(await owner.roleAssignment.count({ where: { workspaceId: other } })).toBe(1); // the other workspace is untouched
  });
});

describe("org people (I-26)", () => {
  it("deactivating a person with no workspace role still writes one org-level audit row", async () => {
    const loner = testUser("life-loner", randomUUID());
    await owner.user.create({ data: { id: loner.id, orgId, email: loner.email, name: loner.sub, googleSub: `g-${loner.sub}` } });
    try {
      const res = await call(superadmin, "PATCH", `/org/people/${loner.id}`, { isActive: false }, null);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      // W0-6: an org-level (workspace_id NULL) audit row needs is_org_admin AND an exact org match.
      const rows = await asOrgAdmin(
        owner,
        (tx) =>
          tx.$queryRawUnsafe<Array<{ n: number; ws: string | null }>>(
            `SELECT count(*)::int AS n, min(workspace_id::text) AS ws FROM audit_event WHERE action = 'person.updated' AND entity_id = $1::uuid`,
            loner.id,
          ),
        orgId,
      );
      expect(rows[0]?.n).toBe(1);
      expect(rows[0]?.ws).toBeNull();
    } finally {
      await asOrgAdmin(owner, (tx) => tx.$executeRawUnsafe(`DELETE FROM audit_event WHERE entity_id = $1::uuid`, loner.id), orgId).catch(() => undefined);
      await owner.user.deleteMany({ where: { id: loner.id } });
    }
  });
});

describe("templates (I-26)", () => {
  it("GET /workspace-templates leaves row counts unchanged (read-only, no write on GET)", async () => {
    const countBefore = await owner.workspaceTemplate.count();
    const toursBefore = await owner.tour.count({ where: { workspaceId: null } });

    // Call GET /workspace-templates (no workspace context)
    const result = await call(superadmin, "GET", "/workspace-templates", undefined, null);
    expect(result.status).toBe(200);

    const countAfter = await owner.workspaceTemplate.count();
    const toursAfter = await owner.tour.count({ where: { workspaceId: null } });

    expect(countAfter).toBe(countBefore);
    expect(toursAfter).toBe(toursBefore);
  });
});
