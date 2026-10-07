import type { PeopleResponse } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * GET /workspaces/:ws/members (the Roles page): the people and groups with a role in this
 * workspace, each with those roles (ORG-005: a workspace admin never sees who works only in other
 * workspaces). A superadmin sees the whole org, to give anyone a role here. `signedIn` is false for
 * someone added by email who has not signed in yet; `orgAdmin` marks a superadmin.
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
    const withRole = new Set(here.map((a) => `${a.principalType}:${a.principalId}`));
    const visible = (type: string, id: string) => auth.isOrgAdmin || withRole.has(`${type}:${id}`);
    const rolesOf = (type: string, id: string) => here.filter((a) => a.principalType === type && a.principalId === id).map((a) => ({ id: a.id, role: a.role, scope: a.scope }));
    return {
      users: users.filter((u) => visible("user", u.id)).map((u) => ({ id: u.id, email: u.email, name: u.name, isActive: u.isActive, signedIn: u.lastSignInAt !== null || u.googleSub !== null, lastSignInAt: u.lastSignInAt?.toISOString() ?? null, orgAdmin: admins.has(u.id), roles: rolesOf("user", u.id) })),
      groups: groups.filter((g) => visible("group", g.id)).map((g) => ({ id: g.id, name: g.name, googleGroup: g.googleGroup, memberCount: g._count.members, roles: rolesOf("group", g.id) })),
    };
  });
}
