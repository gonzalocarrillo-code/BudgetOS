import { MarkNotificationsReadInput, type NotificationsResponse } from "@budget/domain";
import { audit, listNotifications, markNotificationsRead, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * The header bell (DS-003): the in-app notifications the notify worker writes for the caller in
 * this workspace, newest first, and marking them read. RLS keeps them to the workspace; the
 * queries keep them to the caller.
 */
export async function myNotifications(prisma: PrismaClient, auth: AuthContext): Promise<NotificationsResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => listNotifications(tx, workspaceId, auth.user.id, 20));
}

/** POST /me/notifications/read — one audit_event and one outbox row when anything changed. */
export async function readNotifications(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(MarkNotificationsReadInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const changed = await markNotificationsRead(tx, workspaceId, auth.user.id, input.ids ?? null);
    if (changed > 0) {
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "notifications.read", entityType: "user", entityId: auth.user.id, after: { count: changed, all: input.ids === undefined }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "notifications.read", payload: { userId: auth.user.id, count: changed } });
    }
    return { read: changed };
  });
}
