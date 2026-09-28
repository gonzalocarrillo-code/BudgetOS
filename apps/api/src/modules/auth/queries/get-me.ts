import { permissions, type Action, type Role } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { AccessRepository } from "../../../common/auth/access.repository.js";
import type { AuthContext } from "../../../common/tenant.js";

export interface MeWorkspace {
  workspaceId: string;
  name: string;
  currency: string;
  roles: Role[];
  permissions: Action[];
}

export interface Me {
  user: { id: string; email: string; name: string; orgId: string };
  isOrgAdmin: boolean;
  /** ADR-052: the org-wide role, shown as "Superadmin". Same value as isOrgAdmin. */
  isSuperadmin: boolean;
  workspaces: MeWorkspace[];
  /** Superadmins only: archived workspaces, read-only, to restore or delete from the org console. */
  archivedWorkspaces: Array<{ workspaceId: string; name: string; archivedAt: string | null }>;
}

/** GET /me: the caller, their roles per workspace in their org, and the resulting permissions. */
export async function getMe(prisma: PrismaClient, access: AccessRepository, auth: AuthContext): Promise<Me> {
  const orgWide = await access.access(auth.user, null, auth.ctx.requestId);
  const workspaces = await withTenant(prisma, auth.ctx, (tx) =>
    tx.workspace.findMany({ where: { orgId: auth.user.orgId, deletedAt: null }, orderBy: { name: "asc" } }),
  );
  const out: MeWorkspace[] = [];
  const archived: Me["archivedWorkspaces"] = [];
  for (const ws of workspaces) {
    // Archived workspaces leave everyone's list; superadmins find them under "Archived".
    if (ws.status === "ARCHIVED") {
      if (orgWide.isOrgAdmin) archived.push({ workspaceId: ws.id, name: ws.name, archivedAt: ws.archivedAt?.toISOString() ?? null });
      continue;
    }
    const a = await access.access(auth.user, ws.id, auth.ctx.requestId);
    const roles = [...new Set(a.assignments.map((x) => x.role))].sort() as Role[];
    if (roles.length === 0) continue;
    const granted = new Set<Action>(roles.flatMap((r) => [...permissions[r]]));
    out.push({ workspaceId: ws.id, name: ws.name, currency: ws.reportingCurrency, roles, permissions: [...granted].sort() });
  }
  return { user: auth.user, isOrgAdmin: orgWide.isOrgAdmin, isSuperadmin: orgWide.isOrgAdmin, workspaces: out, archivedWorkspaces: archived };
}
