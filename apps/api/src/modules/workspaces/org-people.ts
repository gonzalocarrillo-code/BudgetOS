import { DomainError, UpdateOrgPersonInput, type OrgPeopleResponse } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * The org directory (ADR-052, org console › People): superadmins only. Everyone in the org, the
 * workspaces where they hold roles, and deactivate / reactivate. A deactivated person cannot sign
 * in (authenticate refuses inactive users) and keeps their history.
 */
const orgCtx = (auth: AuthContext) => ({ ...auth.ctx, workspaceId: null, isOrgAdmin: true, actingAs: "superadmin" as const });

export async function listOrgPeople(prisma: PrismaClient, auth: AuthContext): Promise<OrgPeopleResponse> {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only a superadmin sees the whole organization");
  return withTenant(prisma, orgCtx(auth), async (tx) => {
    const [users, roles, workspaces] = await Promise.all([
      tx.user.findMany({ where: { orgId: auth.user.orgId }, orderBy: [{ name: "asc" }, { email: "asc" }] }),
      tx.roleAssignment.findMany({ where: { principalType: "user" }, select: { principalId: true, workspaceId: true, role: true } }),
      tx.workspace.findMany({ where: { orgId: auth.user.orgId, deletedAt: null }, select: { id: true, name: true } }),
    ]);
    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    return {
      people: users.map((u) => {
        const mine = roles.filter((r) => r.principalId === u.id);
        const byWs = new Map<string, string[]>();
        for (const r of mine) if (r.workspaceId && names.has(r.workspaceId)) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r.role]);
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          isActive: u.isActive,
          signedIn: u.googleSub !== null,
          superadmin: mine.some((r) => r.workspaceId === null && r.role === "ORG_ADMIN"),
          workspaces: [...byWs.entries()].map(([workspaceId, rs]) => ({ workspaceId, name: names.get(workspaceId) as string, roles: [...new Set(rs)].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
        };
      }),
    };
  });
}

/** PATCH /org/people/:id { isActive } — one audit_event and one outbox row per workspace they work in. */
export async function updateOrgPerson(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only a superadmin changes who can sign in");
  const id = parseId(rawId);
  const input = parseInput(UpdateOrgPersonInput, raw);
  if (id === auth.user.id && !input.isActive) throw new DomainError("CONFLICT", "You can't deactivate yourself");
  return withTenant(prisma, orgCtx(auth), async (tx) => {
    const u = await tx.user.findFirst({ where: { id, orgId: auth.user.orgId }, select: { id: true, isActive: true, email: true } });
    if (u === null) throw new DomainError("NOT_FOUND", "Person not found");
    if (u.isActive === input.isActive) return { id, isActive: input.isActive, changed: false };
    await tx.user.update({ where: { id }, data: { isActive: input.isActive } });
    // audit_event is per workspace: record it in each workspace where the person holds a role.
    const where = [...new Set((await tx.roleAssignment.findMany({ where: { principalType: "user", principalId: id, workspaceId: { not: null } }, select: { workspaceId: true } })).map((r) => r.workspaceId as string))];
    for (const workspaceId of where) {
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: input.isActive ? "user.reactivated" : "user.deactivated", entityType: "user", entityId: id, before: { isActive: u.isActive }, after: { isActive: input.isActive }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: input.isActive ? "user.reactivated" : "user.deactivated", userId: id } });
    }
    return { id, isActive: input.isActive, changed: true };
  });
}
