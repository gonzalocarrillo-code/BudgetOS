import { randomUUID } from "node:crypto";
import { DomainError, SLACK_ACTIONS, SlackActionValue, SlackSettings, SlackTestInput, UpdateSlackSettingsInput, type SlackActionId } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authenticateVerifiedEmail, type AuthDeps } from "../../common/auth/authenticate.js";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { decide } from "../approvals/commands/decide.js";
import { listAlerts } from "../pacing/queries.js";
import { updateAlert } from "../pacing/rules.js";
import { search } from "../search/search.js";
import { slackApi } from "./slack-api.js";

/**
 * Slack (product feedback 2026-09-28, ADR-046): the workspace's Slack settings, the bot's buttons
 * (acknowledge, snooze, resolve an alert; approve or reject a request) and the /budget command.
 * A Slack user acts as the Budget OS account with the same email, in a workspace linked to their
 * Slack team, with that account's permissions: the same commands as the app, so the same checks,
 * audit and outbox. Messages are posted and kept current by the notify worker.
 */

const settingsOf = (raw: unknown) => SlackSettings.parse(((raw ?? {}) as { slack?: unknown }).slack ?? {});
const appUrl = () => (process.env["APP_BASE_URL"] ?? "http://localhost:5173").replace(/\/$/, "");
const apiUrl = () => (process.env["API_PUBLIC_URL"] ?? process.env["APP_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");

// ---------------------------------------------------------------------------------------------
// Settings (Admin › Slack)
// ---------------------------------------------------------------------------------------------

/** The app manifest to paste at api.slack.com/apps (Create app › From a manifest). */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: { name: "Budget OS", description: "Budgets, pacing alerts and approvals", background_color: "#1f4ed8" },
    features: {
      bot_user: { display_name: "Budget OS", always_online: true },
      slash_commands: [{ command: "/budget", url: `${apiUrl()}/api/v1/slack/commands`, description: "Alerts, search and budgets from Budget OS", usage_hint: "alerts | search <text> | <budget name>", should_escape: false }],
    },
    oauth_config: { scopes: { bot: ["chat:write", "chat:write.public", "commands", "users:read", "users:read.email", "im:write"] } },
    settings: { interactivity: { is_enabled: true, request_url: `${apiUrl()}/api/v1/slack/interactions` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

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

// ---------------------------------------------------------------------------------------------
// Who is acting
// ---------------------------------------------------------------------------------------------

async function slackAuth(prisma: PrismaClient, deps: Pick<AuthDeps, "access" | "cache">, workspaceId: string, teamId: string, slackUserId: string): Promise<AuthContext> {
  const api = slackApi();
  if (api === null) throw new DomainError("FORBIDDEN", "Slack is not connected");
  const email = await api.userEmail(slackUserId);
  if (!email) throw new DomainError("FORBIDDEN", "Your Slack profile has no email Budget OS can match");
  const auth = await authenticateVerifiedEmail(deps, { email, workspaceId, requestId: `slack-${randomUUID()}` });
  // Only the Slack team this workspace is linked to may act on it.
  const ws = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }));
  if (settingsOf(ws.settings).teamId !== teamId) throw new DomainError("FORBIDDEN", "This Budget OS workspace is not linked to your Slack workspace");
  return auth;
}

// ---------------------------------------------------------------------------------------------
// Buttons and forms (POST /slack/interactions)
// ---------------------------------------------------------------------------------------------

interface InteractionPayload {
  type: string;
  team: { id: string };
  user: { id: string };
  trigger_id?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}

/** Slack posts `payload=<json>` (form-encoded); the fields used here are checked, the rest ignored. */
function parseInteraction(raw: unknown): InteractionPayload {
  const body = raw as { payload?: unknown } | null;
  if (typeof body?.payload !== "string") throw new DomainError("VALIDATION", "Missing Slack payload");
  const p = JSON.parse(body.payload) as { type?: unknown; team?: { id?: unknown }; user?: { id?: unknown } };
  if (typeof p.type !== "string" || typeof p.team?.id !== "string" || typeof p.user?.id !== "string") throw new DomainError("VALIDATION", "Unexpected Slack payload");
  return p as InteractionPayload;
}

const message = (title: string, text: string) => ({ type: "modal", title: { type: "plain_text", text: title.slice(0, 24) }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }] });

function rejectForm(value: SlackActionValue): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "approval.reject",
    private_metadata: JSON.stringify(value),
    title: { type: "plain_text", text: "Reject request" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "reason", label: { type: "plain_text", text: "Why? (the requester sees this)" }, element: { type: "plain_text_input", action_id: "reason", multiline: true, min_length: 3 } }],
  };
}

/** One button click or form submission. Returns the HTTP body Slack expects. */
export async function handleInteraction(prisma: PrismaClient, deps: Pick<AuthDeps, "access" | "cache">, raw: unknown): Promise<Record<string, unknown>> {
  const p = parseInteraction(raw);
  const api = slackApi();
  if (p.type === "view_submission" && p.view?.callback_id === "approval.reject") {
    const value = SlackActionValue.parse(JSON.parse(p.view.private_metadata ?? "{}"));
    const reason = p.view.state?.values?.["reason"]?.["reason"]?.value?.trim() ?? "";
    try {
      const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
      await decide(prisma, auth, value.id, { decision: "reject", comment: reason, channel: "slack" });
      return {};
    } catch (e) {
      return { response_action: "errors", errors: { reason: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (p.type !== "block_actions") return {};
  const action = p.actions?.[0];
  if (!action || !(SLACK_ACTIONS as readonly string[]).includes(action.action_id)) return {}; // a link button: Slack opens it
  const id = action.action_id as SlackActionId;
  const value = SlackActionValue.parse(JSON.parse(action.value ?? "{}"));
  try {
    const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
    if (id === "approval.reject") {
      if (api && p.trigger_id) await api.openView(p.trigger_id, rejectForm(value));
      return {};
    }
    if (id === "approval.approve") await decide(prisma, auth, value.id, { decision: "approve", channel: "slack" });
    else if (id === "alert.acknowledge") await updateAlert(prisma, auth, value.id, { status: "ACKNOWLEDGED" });
    else if (id === "alert.snooze") await updateAlert(prisma, auth, value.id, { status: "SNOOZED", snoozedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    else if (id === "alert.resolve") await updateAlert(prisma, auth, value.id, { status: "RESOLVED" });
    // The message itself is edited by the notify worker when the change's event arrives.
    return {};
  } catch (e) {
    // Tell the person why, privately (a small form they close); nothing changed.
    if (api && p.trigger_id) await api.openView(p.trigger_id, message("Budget OS", `:no_entry: ${e instanceof Error ? e.message : String(e)}`)).catch(() => undefined);
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// /budget (POST /slack/commands)
// ---------------------------------------------------------------------------------------------

const reply = (text: string, blocks?: unknown[]) => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });
const pct = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${Math.round(Number(v) * 100)}%`);
const money = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en", { maximumFractionDigits: 0 }));

const HELP = [
  "*Budget OS* — `/budget` answers only you:",
  "• `/budget alerts` — open alerts you can see",
  "• `/budget search <text>` — budgets, approvals, alerts, targets",
  "• `/budget <budget name>` — a budget's amount, spend and pace",
].join("\n");

/** The workspaces of the Slack user's org that are linked to their Slack team and where they have a role. */
async function workspacesFor(prisma: PrismaClient, deps: Pick<AuthDeps, "access" | "cache">, teamId: string, email: string): Promise<Array<{ id: string; name: string }>> {
  const user = await deps.access.findUser({ sub: `external:${email}`, email, emailVerified: true, googleSub: null });
  if (user === null || !user.isActive) return [];
  const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user" as const, requestId: `slack-${randomUUID()}` };
  const all = await withTenant(prisma, ctx, (tx) => tx.workspace.findMany({ where: { orgId: user.orgId }, select: { id: true, name: true, settings: true }, orderBy: { name: "asc" } }));
  return all.filter((w) => settingsOf(w.settings).teamId === teamId).map((w) => ({ id: w.id, name: w.name }));
}

export async function handleCommand(prisma: PrismaClient, deps: Pick<AuthDeps, "access" | "cache">, raw: unknown): Promise<Record<string, unknown>> {
  const body = (raw ?? {}) as Record<string, string | undefined>;
  const teamId = body["team_id"] ?? "";
  const userId = body["user_id"] ?? "";
  const text = (body["text"] ?? "").trim();
  const api = slackApi();
  if (api === null) return reply("Budget OS is not connected to Slack yet.");
  if (text === "" || text === "help") return reply(HELP);
  const email = await api.userEmail(userId);
  if (!email) return reply("Your Slack profile has no email Budget OS can match.");
  const linked = await workspacesFor(prisma, deps, teamId, email);
  let auth: AuthContext | null = null;
  let chosen: { id: string; name: string } | null = null;
  for (const w of linked) {
    try {
      auth = await authenticateVerifiedEmail(deps, { email, workspaceId: w.id, requestId: `slack-${randomUUID()}` });
      if (auth.roles.length > 0) {
        chosen = w;
        break;
      }
    } catch {
      // no access to this one; try the next
    }
  }
  if (!auth || !chosen) return reply("No Budget OS workspace linked to this Slack workspace gives you access. An admin links one in Admin › Slack.");
  const ws = chosen.id;
  const url = (path: string) => `${appUrl()}/w/${ws}${path}`;
  const footer = linked.length > 1 ? ` · workspace *${chosen.name}*` : "";
  try {
    if (text === "alerts") {
      const alerts = (await listAlerts(prisma, auth, { limit: "10" })) as Array<{ id: string; severity: string; status: string; envelopeName: string | null; ruleName: string | null }>;
      if (alerts.length === 0) return reply(`No open alerts. :white_check_mark:${footer}`);
      const lines = alerts.map((a) => `• *${a.severity}* <${url(`/alerts?select=${a.id}`)}|${a.envelopeName ?? "Budget"}> — ${a.ruleName ?? "rule"} (${a.status.toLowerCase()})`);
      return reply(`${alerts.length} open alerts${footer}`, [{ type: "section", text: { type: "mrkdwn", text: `*Open alerts*${footer}\n${lines.join("\n")}`.slice(0, 2900) } }]);
    }
    const isSearch = text.startsWith("search ");
    const q = isSearch ? text.slice("search ".length) : text;
    const res = await search(prisma, auth, { q, limit: isSearch ? "5" : "3", ...(isSearch ? {} : { types: "envelope" }) });
    const groups = res.groups as Array<{ type: string; count: number; hits: Array<{ title: string; path: string | null; deepLink: string; facets?: Record<string, unknown> | null }> }>;
    if (groups.length === 0) return reply(`Nothing matches “${q}”.${footer}`);
    const lines = groups.flatMap((g) =>
      g.hits.map((h) => {
        const f = h.facets ?? {};
        const numbers = g.type === "envelope" ? ` — budget ${money(f["budget"])}, spent ${money(f["actual"])}${f["budget"] ? ` (${pct(Number(f["actual"] ?? 0) / Number(f["budget"]))})` : ""}${f["pace_index"] !== undefined && f["pace_index"] !== null ? `, pace ${Number(f["pace_index"]).toFixed(2)}` : ""}` : "";
        return `• <${appUrl()}${h.deepLink}|${h.title}>${h.path ? ` _${h.path}_` : ""}${numbers}`;
      }),
    );
    return reply(`Results for “${q}”${footer}`, [{ type: "section", text: { type: "mrkdwn", text: `*${isSearch ? "Search" : "Budgets"}: ${q}*${footer}\n${lines.join("\n")}`.slice(0, 2900) } }]);
  } catch (e) {
    return reply(`:no_entry: ${e instanceof Error ? e.message : String(e)}`);
  }
}
