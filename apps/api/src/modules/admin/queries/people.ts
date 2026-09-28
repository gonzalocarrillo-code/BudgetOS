import type { PeopleResponse } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * GET /workspaces/:ws/members (the Roles page): everyone in the workspace's org and every group,
 * each with its role assignments in this workspace. `signedIn` is false for someone added by email
 * who has not signed in yet; `orgAdmin` marks the org-wide role, managed outside a workspace.
 */
export async function listPeople(prisma: PrismaClient, auth: AuthContext): Promise<PeopleResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true } });
    const [users, groups, here, orgAdmins] = await Promise.all([
      tx.user.findMany({ where: { orgId: ws.orgId }, orderBy: [{ name: "asc" }, { email: "asc" }] }),
      tx.group.findMany({ where: { orgId: ws.orgId }, include: { _count: { select: { members: true } } }, orderBy: { name: "asc" } }),
      tx.roleAssignment.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
      tx.roleAssignment.findMany({ where: { workspaceId: null, role: "ORG_ADMIN", principalType: "user" }, select: { principalId: true } }),
    ]);
    const admins = new Set(orgAdmins.map((a) => a.principalId));
    const rolesOf = (type: string, id: string) => here.filter((a) => a.principalType === type && a.principalId === id).map((a) => ({ id: a.id, role: a.role, scope: a.scope }));
    return {
      users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, isActive: u.isActive, signedIn: u.googleSub !== null, orgAdmin: admins.has(u.id), roles: rolesOf("user", u.id) })),
      groups: groups.map((g) => ({ id: g.id, name: g.name, googleGroup: g.googleGroup, memberCount: g._count.members, roles: rolesOf("group", g.id) })),
    };
  });
}
