import { permissions, type Action, type Role } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import type { AccessRepository } from "../../../common/auth/access.repository.js";
import type { AuthContext } from "../../../common/tenant.js";

export interface MeWorkspace {
  workspaceId: string;
  name: string;
  roles: Role[];
  permissions: Action[];
}

export interface Me {
  user: { id: string; email: string; name: string; orgId: string };
  isOrgAdmin: boolean;
  workspaces: MeWorkspace[];
}

/** GET /me: the caller, their roles per workspace in their org, and the resulting permissions. */
export async function getMe(prisma: PrismaClient, access: AccessRepository, auth: AuthContext): Promise<Me> {
  const orgWide = await access.access(auth.user.id, null);
  const workspaces = await prisma.workspace.findMany({ where: { orgId: auth.user.orgId }, orderBy: { name: "asc" } });
  const out: MeWorkspace[] = [];
  for (const ws of workspaces) {
    const a = await access.access(auth.user.id, ws.id);
    const roles = [...new Set(a.assignments.map((x) => x.role))].sort() as Role[];
    if (roles.length === 0) continue;
    const granted = new Set<Action>(roles.flatMap((r) => [...permissions[r]]));
    out.push({ workspaceId: ws.id, name: ws.name, roles, permissions: [...granted].sort() });
  }
  return { user: auth.user, isOrgAdmin: orgWide.isOrgAdmin, workspaces: out };
}
