import { SlackUserSettings } from "@budget/domain";
import { audit, outbox, setMySlackSettings, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** The caller's own Slack settings (app_user.settings.slack, S-010). */
export async function mySlackSettings(prisma: PrismaClient, auth: AuthContext): Promise<SlackUserSettings> {
  const me = await withTenant(prisma, auth.ctx, (tx) => tx.user.findUnique({ where: { id: auth.user.id }, select: { settings: true } }));
  const parsed = SlackUserSettings.safeParse(((me?.settings ?? {}) as { slack?: unknown }).slack ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * The workspace /budget answers for when the caller types it outside a workspace's channel (S-010):
 * the workspace of `auth`, where they hold a role. Audited in that workspace, with its outbox row.
 */
export async function setSlackWorkspace(prisma: PrismaClient, auth: AuthContext): Promise<SlackUserSettings> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const before = await mySlackSettings(prisma, auth);
  const after = SlackUserSettings.parse({ ...before, defaultWorkspaceId: workspaceId });
  return withTenant(prisma, auth.ctx, async (tx) => {
    await setMySlackSettings(tx, after);
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.slack_settings_changed", entityType: "app_user", entityId: auth.user.id, before, after, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "user.updated", payload: { userId: auth.user.id } });
    return after;
  });
}
