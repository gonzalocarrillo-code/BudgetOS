import { ScopeFilter, type Role, type ScopedRole } from "@budget/domain";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { VerifiedIdentity } from "./jwt-verifier.js";
import type { WorkspaceAccess } from "./role-cache.js";

export interface AppUserRef {
  id: string;
  orgId: string;
  email: string;
  name: string;
  isActive: boolean;
}

/**
 * Identity and role lookups. app_user, app_group(_member) and role_assignment are org tables
 * without RLS, so these reads run before a TenantContext exists.
 */
@Injectable()
export class AccessRepository {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** Match on the Google account id or Identity Platform uid, else on a verified email. */
  async findUser(identity: VerifiedIdentity): Promise<AppUserRef | null> {
    const subs = [identity.sub, ...(identity.googleSub ? [identity.googleSub] : [])];
    const bySub = await this.prisma.user.findFirst({ where: { googleSub: { in: subs } } });
    if (bySub) return bySub;
    if (!identity.emailVerified) return null;
    return this.prisma.user.findUnique({ where: { email: identity.email } });
  }

  async workspaceOrg(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { orgId: true } });
    return ws?.orgId ?? null;
  }

  /** Assignments for the user in `workspaceId` (or org-wide only when null), including via groups. */
  async access(userId: string, workspaceId: string | null): Promise<WorkspaceAccess> {
    const groups = await this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [
              { principalType: "user", principalId: userId },
              { principalType: "group", principalId: { in: groups.map((g) => g.groupId) } },
            ],
          },
          { OR: [{ workspaceId: null }, ...(workspaceId ? [{ workspaceId }] : [])] },
        ],
      },
    });
    const assignments: ScopedRole[] = [];
    let isOrgAdmin = false;
    for (const row of rows) {
      // Only ORG_ADMIN is meaningful org-wide; any other role needs a workspace.
      if (row.workspaceId === null && row.role !== "ORG_ADMIN") continue;
      if (row.role === "ORG_ADMIN") isOrgAdmin = true;
      const scope = ScopeFilter.safeParse(row.scope);
      // An unreadable scope grants nothing rather than everything.
      if (!scope.success) continue;
      assignments.push({ role: row.role as Role, scope: scope.data });
    }
    return { isOrgAdmin, assignments };
  }
}
