import { DomainError, OrgSlackTestInput, SlackSettings, SlackTestInput, UpdateOrgSlackInput, UpdateSlackSettingsInput } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { slackManifest } from "./manifest.js";
import { apiUrl, orgSlackOf, slackSettingsOf as settingsOf, slackTeamOf } from "./slack-config.js";
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

const secretsSet = () => ({ botToken: slackApi() !== null, signingSecret: Boolean(process.env["SLACK_SIGNING_SECRET"]) });

/**
 * GET /workspaces/:ws/integrations/slack (R11-003): whether the org is connected, to which team,
 * and this workspace's routing. The connection itself is the org console's (getOrgSlack).
 */
export async function getSlackSettings(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const { ws, org } = await withTenant(prisma, auth.ctx, async (tx) => ({
    ws: await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }),
    org: await tx.organization.findUnique({ where: { id: auth.user.orgId }, select: { settings: true } }),
  }));
  const secrets = secretsSet();
  const team = slackTeamOf(org?.settings, ws.settings);
  const s = settingsOf(ws.settings);
  // Routing only: the team is the org's (the legacy per-workspace team is not shown).
  const settings = { defaultChannel: s.defaultChannel, alertChannel: s.alertChannel, alertSeverities: s.alertSeverities, approvals: s.approvals, dms: s.dms };
  return { connected: secrets.botToken && secrets.signingSecret && team !== null, team, settings };
}

/** PATCH /workspaces/:ws/integrations/slack: this workspace's channels, severities, approvals and DMs. */
export async function updateSlackSettings(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(UpdateSlackSettingsInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
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

// ---------------------------------------------------------------------------------------------
// The org's connection (Org console › Slack, R11-002)
// ---------------------------------------------------------------------------------------------

/** The org routes run as the org admin, whatever workspace header came with them (as org-people.ts). */
const orgCtx = (auth: AuthContext) => {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only a superadmin connects the organization to Slack");
  return { ...auth.ctx, workspaceId: null, isOrgAdmin: true, actingAs: "superadmin" as const };
};

/** GET /org/integrations/slack: the secrets, the linked team, the URLs Slack calls and the manifest. */
export async function getOrgSlack(prisma: PrismaClient, auth: AuthContext) {
  const { org, workspaces } = await withTenant(prisma, orgCtx(auth), async (tx) => ({
    org: await tx.organization.findUniqueOrThrow({ where: { id: auth.user.orgId }, select: { settings: true } }),
    workspaces: await tx.workspace.findMany({ where: { orgId: auth.user.orgId, deletedAt: null, status: "ACTIVE" }, select: { id: true, name: true, settings: true }, orderBy: { name: "asc" } }),
  }));
  const slack = orgSlackOf(org.settings);
  return {
    secrets: secretsSet(),
    team: slack.teamId ? { id: slack.teamId, name: slack.teamName ?? null, linkedAt: slack.linkedAt ?? null, linkedBy: slack.linkedBy ?? null } : null,
    urls: { interactions: `${apiUrl()}/api/v1/slack/interactions`, commands: `${apiUrl()}/api/v1/slack/commands` },
    manifest: slackManifest(),
    // Which workspaces post where: the org admin sees who has not picked a channel yet.
    workspaces: workspaces.map((w) => {
      const s = settingsOf(w.settings);
      return { id: w.id, name: w.name, defaultChannel: s.defaultChannel ?? null, alertChannel: s.alertChannel ?? null };
    }),
  };
}

/** PATCH /org/integrations/slack: link the org to the bot's Slack team (auth.test), or unlink it. */
export async function updateOrgSlack(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(UpdateOrgSlackInput, raw);
  let team: { id: string; name: string } | null = null;
  if (input.link) {
    const api = slackApi();
    if (api === null) throw new DomainError("VALIDATION", "Slack is not connected: the bot token and signing secret are not set");
    team = await api.team();
    if (team === null) throw new DomainError("VALIDATION", "The bot token did not name a Slack team");
  }
  return withTenant(prisma, orgCtx(auth), async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: auth.user.orgId }, select: { settings: true } });
    const all = (org.settings ?? {}) as Record<string, unknown>;
    const before = orgSlackOf(all);
    const after = team ? { teamId: team.id, teamName: team.name, linkedAt: new Date().toISOString(), linkedBy: auth.user.email } : {};
    await tx.organization.update({ where: { id: auth.user.orgId }, data: { settings: { ...all, slack: after } as Prisma.InputJsonValue } });
    await audit(tx, { workspaceId: null, actorId: auth.user.id, actorType: auth.ctx.actorType, action: team ? "slack.org_linked" : "slack.org_unlinked", entityType: "organization", entityId: auth.user.orgId, before, after, requestId: auth.ctx.requestId });
    // Every workspace of the org now answers to this team (or to none): one event each.
    const workspaces = await tx.workspace.findMany({ where: { orgId: auth.user.orgId, deletedAt: null }, select: { id: true } });
    for (const w of workspaces) await outbox(tx, { workspaceId: w.id, topic: "slack.settings.changed", payload: { workspaceId: w.id, orgTeamId: team?.id ?? null } });
    return after;
  });
}

/** POST /org/integrations/slack/test: a hello to a channel, posted by the notify worker. */
export async function sendOrgSlackTest(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(OrgSlackTestInput, raw);
  return withTenant(prisma, orgCtx(auth), async (tx) => {
    // The worker delivers per workspace: the org's first active workspace carries the test.
    const ws = await tx.workspace.findFirst({ where: { orgId: auth.user.orgId, deletedAt: null, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!ws) throw new DomainError("VALIDATION", "Create a workspace first: the test is sent through it");
    await audit(tx, { workspaceId: ws.id, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "slack.test_requested", entityType: "organization", entityId: auth.user.orgId, before: null, after: { channel: input.channel }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: ws.id, topic: "slack.test", payload: { channel: input.channel, requestedBy: auth.user.name } });
    return { queued: true, channel: input.channel };
  });
}
