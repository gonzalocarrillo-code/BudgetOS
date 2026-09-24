import { ScopeFilter, type Role, type ScopedRole } from "@budget/domain";
import { withIdentity, withTenant } from "@budget/db";
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
 * Identity and role lookups. `findUser` runs in withIdentity(), which exposes only the app_user
 * matching the verified token. The org is known after that, so the other lookups run in
 * withTenant() with the user's org (migrations 20260924020000 and 20260924030000).
 * app_group_member has no RLS.
 */
@Injectable()
export class AccessRepository {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** Match on the Google account id or Identity Platform uid, else on a verified email. */
  async findUser(identity: VerifiedIdentity): Promise<AppUserRef | null> {
    const subs = [identity.sub, ...(identity.googleSub ? [identity.googleSub] : [])];
    const email = identity.emailVerified ? identity.email : null;
    return withIdentity(this.prisma, { subs, email }, async (tx) => {
      const bySub = await tx.user.findFirst({ where: { googleSub: { in: subs } } });
      if (bySub) return bySub;
      if (email === null) return null;
      return tx.user.findUnique({ where: { email } });
    });
  }

  /** The workspace's org, or null when it does not exist or belongs to another org (RLS hides it). */
  async workspaceOrg(workspaceId: string, user: { id: string; orgId: string }, requestId: string): Promise<string | null> {
    const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user" as const, requestId };
    const ws = await withTenant(this.prisma, ctx, (tx) =>
      tx.workspace.findUnique({ where: { id: workspaceId }, select: { orgId: true } }),
    );
    return ws?.orgId ?? null;
  }

  /** Assignments for the user in `workspaceId` (or org-wide only when null), including via groups. */
  async access(
    user: { id: string; orgId: string },
    workspaceId: string | null,
    requestId: string,
  ): Promise<WorkspaceAccess> {
    const userId = user.id;
    const groups = await this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    const ctx = { workspaceId, orgId: user.orgId, userId, isOrgAdmin: false, actorType: "user" as const, requestId };
    const rows = await withTenant(this.prisma, ctx, (tx) => tx.roleAssignment.findMany({
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
    }));
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
