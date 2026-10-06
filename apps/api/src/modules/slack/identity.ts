import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { audit, linkMySlackUser, outbox, withTenant } from "@budget/db";
import { log } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { authenticateVerifiedEmail, type AuthDeps } from "../../common/auth/authenticate.js";
import { mySlackSettings } from "../auth/commands/slack-workspace.js";
import type { AuthContext } from "../../common/tenant.js";
import { slackSettingsOf, slackTeamOf } from "./slack-config.js";
import { slackApi } from "./slack-api.js";

/**
 * Who is acting from Slack (ADR-046): the Budget OS account with the Slack user's profile email, in
 * a workspace linked to their Slack team, with that account's roles there. S-14 (ADR-075): the
 * email alone is not proof of identity — a Slack workspace admin can set anyone's email on their
 * own profile — so the Slack user id is pinned to the app user on first contact and checked on
 * every request after.
 */

export type SlackDeps = Pick<AuthDeps, "access" | "cache">;

export const slackRequestId = () => `slack-${randomUUID()}`;

const relinkMessage = (email: string) => `This Slack account is not the one linked to ${email}; ask an org admin to relink`;

/** DomainError.details marker so a mismatch is never swallowed as "no access to this workspace" (chooseWorkspace). */
const IDENTITY_MISMATCH = { slackIdentityMismatch: true } as const;

/**
 * S-14: pins `auth`'s app user to `slackUserId` the first time they are seen together, and refuses
 * when they don't match — either because this app user is already pinned to a different Slack
 * account, or because this Slack account is already pinned to a different app user of the org.
 * One audit_event (`person.slack_linked`, org-level: the identity is the app_user's, not any one
 * workspace's) and one outbox row on first link; nothing is written once the pin already matches.
 */
async function pinSlackIdentity(prisma: PrismaClient, auth: AuthContext, slackUserId: string, email: string): Promise<void> {
  await withTenant(prisma, auth.ctx, async (tx) => {
    const me = await tx.user.findUniqueOrThrow({ where: { id: auth.user.id }, select: { slackUserId: true } });
    if (me.slackUserId === slackUserId) return;
    if (me.slackUserId !== null) {
      log.warn({ requestId: auth.ctx.requestId, userId: auth.user.id, email, linkedSlackUserId: me.slackUserId, callerSlackUserId: slackUserId }, "slack: Slack account does not match the one linked to this email");
      throw new DomainError("FORBIDDEN", relinkMessage(email), IDENTITY_MISMATCH);
    }
    const linked = await linkMySlackUser(tx, slackUserId);
    if (linked.conflict) {
      log.warn({ requestId: auth.ctx.requestId, userId: auth.user.id, email, callerSlackUserId: slackUserId }, "slack: Slack account is already linked to a different app user of this org");
      throw new DomainError("FORBIDDEN", relinkMessage(email), IDENTITY_MISMATCH);
    }
    await audit(tx, { workspaceId: null, actorId: auth.user.id, actorType: "user", action: "person.slack_linked", entityType: "app_user", entityId: auth.user.id, before: { slackUserId: null }, after: { slackUserId }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: auth.ctx.workspaceId, topic: "user.updated", payload: { userId: auth.user.id } });
  });
}

/** authenticateVerifiedEmail, then S-14's identity pin: every Slack entry point goes through this, not authenticateVerifiedEmail directly. */
async function authenticateSlackUser(prisma: PrismaClient, deps: SlackDeps, input: { email: string; workspaceId: string; requestId: string; slackUserId: string }): Promise<AuthContext> {
  const auth = await authenticateVerifiedEmail(deps, input);
  await pinSlackIdentity(prisma, auth, input.slackUserId, input.email);
  return auth;
}

export async function slackAuth(prisma: PrismaClient, deps: SlackDeps, workspaceId: string, teamId: string, slackUserId: string): Promise<AuthContext> {
  const api = slackApi();
  if (api === null) throw new DomainError("FORBIDDEN", "Slack is not connected");
  const email = await api.userEmail(slackUserId);
  if (!email) throw new DomainError("FORBIDDEN", "Your Slack profile has no email BudgetOS can match");
  const auth = await authenticateSlackUser(prisma, deps, { email, workspaceId, requestId: slackRequestId(), slackUserId });
  // Only the Slack team this workspace answers to (its org's, R11-002) may act on it.
  const { ws, org } = await withTenant(prisma, auth.ctx, async (tx) => ({
    ws: await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }),
    org: await tx.organization.findUnique({ where: { id: auth.user.orgId }, select: { settings: true } }),
  }));
  if (slackTeamOf(org?.settings, ws.settings)?.id !== teamId) throw new DomainError("FORBIDDEN", "This BudgetOS workspace is not linked to your Slack workspace");
  return auth;
}

export interface LinkedWorkspace {
  id: string;
  name: string;
  slug: string;
  /** Its default and alerts channels, as `name` (no #, lower case) or an id: where /budget answers for it (S-010). */
  channels: string[];
}

const channelKey = (c: string) => (/^[CGD][A-Z0-9]{6,}$/.test(c) ? c : c.replace(/^[#@]/, "").toLowerCase());

/** The workspaces of the Slack user's org that are linked to their Slack team, by name. */
export async function linkedWorkspaces(prisma: PrismaClient, deps: SlackDeps, teamId: string, rawEmail: string): Promise<LinkedWorkspace[]> {
  // Emails are stored lower-case; a Slack profile's may not be (S-001).
  const email = rawEmail.trim().toLowerCase();
  const user = await deps.access.findUser({ sub: `external:${email}`, email, emailVerified: true, googleSub: null });
  if (user === null || !user.isActive) return [];
  const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user" as const, requestId: slackRequestId() };
  const { all, org } = await withTenant(prisma, ctx, async (tx) => ({
    all: await tx.workspace.findMany({ where: { orgId: user.orgId, deletedAt: null, status: "ACTIVE" }, select: { id: true, name: true, slug: true, settings: true }, orderBy: { name: "asc" } }),
    org: await tx.organization.findUnique({ where: { id: user.orgId }, select: { settings: true } }),
  }));
  // R11-002: an org linked to the team links every workspace of it.
  return all
    .map((w) => ({ w, s: slackSettingsOf(w.settings) }))
    .filter(({ w }) => slackTeamOf(org?.settings, w.settings)?.id === teamId)
    .map(({ w, s }) => ({ id: w.id, name: w.name, slug: w.slug, channels: [s.defaultChannel, s.alertChannel].filter((c): c is string => Boolean(c)).map(channelKey) }));
}

export interface ChosenWorkspace {
  auth: AuthContext;
  workspace: LinkedWorkspace;
  /** Every linked workspace where the person holds a role, by name. */
  mine: Array<{ workspace: LinkedWorkspace; auth: AuthContext }>;
  /** Why this one: typed in its channel, the person's default, their only one, or the first by name. */
  how: "channel" | "default" | "only" | "first";
}

/**
 * Which workspace /budget answers for (S-010), among the linked workspaces where the person holds a
 * role: the one whose channel the command was typed in; else their default (/budget workspace);
 * else their only one; else the first by name. Null when they hold a role in none.
 */
export async function chooseWorkspace(prisma: PrismaClient, deps: SlackDeps, input: { teamId: string; email: string; slackUserId: string; channelId?: string | undefined; channelName?: string | undefined }): Promise<ChosenWorkspace | null> {
  const mine: ChosenWorkspace["mine"] = [];
  for (const workspace of await linkedWorkspaces(prisma, deps, input.teamId, input.email)) {
    try {
      const auth = await authenticateSlackUser(prisma, deps, { email: input.email, workspaceId: workspace.id, requestId: slackRequestId(), slackUserId: input.slackUserId });
      if (auth.roles.length > 0) mine.push({ workspace, auth });
    } catch (e) {
      // S-14: a pinned-identity mismatch is refused outright, never read as "not theirs to choose".
      if (e instanceof DomainError && e.details === IDENTITY_MISMATCH) throw e;
      // No access to this one (archived, or not the person's org): it is not theirs to choose.
    }
  }
  const first = mine[0];
  if (first === undefined) return null;
  const pick = (m: (typeof mine)[number], how: ChosenWorkspace["how"]): ChosenWorkspace => ({ auth: m.auth, workspace: m.workspace, mine, how });
  if (mine.length === 1) return pick(first, "only");
  const preferred = (await mySlackSettings(prisma, first.auth)).defaultWorkspaceId;
  const typedIn = [input.channelId, input.channelName].filter((c): c is string => Boolean(c)).map(channelKey);
  const inChannel = mine.filter((m) => m.workspace.channels.some((c) => typedIn.includes(c)));
  const byChannel = inChannel.find((m) => m.workspace.id === preferred) ?? inChannel[0];
  if (byChannel) return pick(byChannel, "channel");
  const byDefault = mine.find((m) => m.workspace.id === preferred);
  return byDefault ? pick(byDefault, "default") : pick(first, "first");
}
