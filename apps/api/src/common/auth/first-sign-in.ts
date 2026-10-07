import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { AppUserRef } from "./access.repository.js";

/**
 * Round 11 (PR 1): the first time a person who was added by email signs in with Google, record one
 * audit_event `user.signed_in_first_time` and one outbox row `access.changed { kind:
 * "user.identity_bound" }` per workspace where they hold a role (copies the loop in
 * updateOrgPerson, apps/api/src/modules/workspaces/org-people.ts). Per-login updates after that are
 * not audited (noise).
 */
export async function recordFirstSignIn(prisma: PrismaClient, user: AppUserRef, requestId: string): Promise<void> {
  const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: true, actorType: "user" as const, requestId };
  await withTenant(prisma, ctx, async (tx) => {
    const roles = await tx.roleAssignment.findMany({ where: { principalType: "user", principalId: user.id, workspaceId: { not: null } }, select: { workspaceId: true } });
    const workspaceIds = [...new Set(roles.map((r) => r.workspaceId as string))];
    for (const workspaceId of workspaceIds) {
      await audit(tx, { workspaceId, actorId: user.id, actorType: "user", action: "user.signed_in_first_time", entityType: "user", entityId: user.id, after: { signedIn: true }, requestId });
      await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "user.identity_bound", userId: user.id } });
    }
  });
}
