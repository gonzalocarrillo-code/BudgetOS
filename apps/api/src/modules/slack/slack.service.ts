import { DomainError, SlackSettings, SlackTestInput, UpdateSlackSettingsInput } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { slackManifest } from "./manifest.js";
import { apiUrl, slackSettingsOf as settingsOf } from "./slack-config.js";
import { slackApi } from "./slack-api.js";

/**
 * Slack (product feedback 2026-09-28, ADR-046): the workspace's Slack settings, the app manifest
 * (manifest.ts) and the test message. The bot's buttons are in interactions.ts, /budget in slash/, and who acts in
 * identity.ts: a Slack user acts as the Budget OS account with the same email, in a workspace linked
 * to their Slack team, with that account's permissions. The notify worker posts and edits messages.
 */

// ---------------------------------------------------------------------------------------------
// Settings (Admin › Slack)
// ---------------------------------------------------------------------------------------------

/** GET /workspaces/:ws/integrations/slack */
export async function getSlackSettings(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const ws = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }));
  return {
    connected: { botToken: Boolean(process.env["SLACK_BOT_TOKEN"]), signingSecret: Boolean(process.env["SLACK_SIGNING_SECRET"]) },
    settings: settingsOf(ws.settings),
    urls: { interactions: `${apiUrl()}/api/v1/slack/interactions`, commands: `${apiUrl()}/api/v1/slack/commands` },
    manifest: slackManifest(),
  };
}

/** PATCH /workspaces/:ws/integrations/slack. `link` reads the bot's Slack team (auth.test). */
export async function updateSlackSettings(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(UpdateSlackSettingsInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  let team: { id: string; name: string } | null = null;
  if (input.link) {
    const api = slackApi();
    if (api === null) throw new DomainError("VALIDATION", "Slack is not connected: set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET, then link");
    team = await api.team();
    if (team === null) throw new DomainError("VALIDATION", "The bot token did not name a Slack team");
  }
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const all = (ws.settings ?? {}) as Record<string, unknown>;
    const before = settingsOf(all);
    const next: Record<string, unknown> = { ...before };
    for (const k of ["defaultChannel", "alertChannel"] as const) {
      if (input[k] === null) delete next[k];
      else if (input[k] !== undefined) next[k] = input[k];
    }
    if (input.alertSeverities !== undefined) next["alertSeverities"] = input.alertSeverities;
    if (input.approvals !== undefined) next["approvals"] = input.approvals;
    if (input.dms !== undefined) next["dms"] = input.dms;
    if (team) {
      next["teamId"] = team.id;
      next["teamName"] = team.name;
    }
    const after = SlackSettings.parse(next);
    await tx.workspace.update({ where: { id: workspaceId }, data: { settings: { ...all, slack: after } as Prisma.InputJsonValue } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "slack.settings_changed", entityType: "workspace", entityId: workspaceId, before, after, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "slack.settings.changed", payload: { workspaceId } });
    return after;
  });
}

/** POST /workspaces/:ws/integrations/slack/test: the notify worker posts a hello to the channel. */
export async function sendSlackTest(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(SlackTestInput, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const channel = input.channel ?? settingsOf(ws.settings).defaultChannel;
    if (!channel) throw new DomainError("VALIDATION", "Set a default channel first, or name one");
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "slack.test_requested", entityType: "workspace", entityId: workspaceId, before: null, after: { channel }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "slack.test", payload: { channel, requestedBy: auth.user.name } });
    return { queued: true, channel };
  });
}
