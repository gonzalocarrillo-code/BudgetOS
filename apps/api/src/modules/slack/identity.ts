import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { authenticateVerifiedEmail, type AuthDeps } from "../../common/auth/authenticate.js";
import type { AuthContext } from "../../common/tenant.js";
import { slackSettingsOf } from "./slack-config.js";
import { slackApi } from "./slack-api.js";

/**
 * Who is acting from Slack (ADR-046): the Budget OS account with the Slack user's profile email, in
 * a workspace linked to their Slack team, with that account's roles there.
 */

export type SlackDeps = Pick<AuthDeps, "access" | "cache">;

export const slackRequestId = () => `slack-${randomUUID()}`;

export async function slackAuth(prisma: PrismaClient, deps: SlackDeps, workspaceId: string, teamId: string, slackUserId: string): Promise<AuthContext> {
  const api = slackApi();
  if (api === null) throw new DomainError("FORBIDDEN", "Slack is not connected");
  const email = await api.userEmail(slackUserId);
  if (!email) throw new DomainError("FORBIDDEN", "Your Slack profile has no email BudgetOS can match");
  const auth = await authenticateVerifiedEmail(deps, { email, workspaceId, requestId: slackRequestId() });
  // Only the Slack team this workspace is linked to may act on it.
  const ws = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }));
  if (slackSettingsOf(ws.settings).teamId !== teamId) throw new DomainError("FORBIDDEN", "This BudgetOS workspace is not linked to your Slack workspace");
  return auth;
}

/** The workspaces of the Slack user's org that are linked to their Slack team, by name. */
export async function linkedWorkspaces(prisma: PrismaClient, deps: SlackDeps, teamId: string, rawEmail: string): Promise<Array<{ id: string; name: string }>> {
  // Emails are stored lower-case; a Slack profile's may not be (S-001).
  const email = rawEmail.trim().toLowerCase();
  const user = await deps.access.findUser({ sub: `external:${email}`, email, emailVerified: true, googleSub: null });
  if (user === null || !user.isActive) return [];
  const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user" as const, requestId: slackRequestId() };
  const all = await withTenant(prisma, ctx, (tx) => tx.workspace.findMany({ where: { orgId: user.orgId }, select: { id: true, name: true, settings: true }, orderBy: { name: "asc" } }));
  return all.filter((w) => slackSettingsOf(w.settings).teamId === teamId).map((w) => ({ id: w.id, name: w.name }));
}
