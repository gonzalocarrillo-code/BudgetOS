import { authenticateVerifiedEmail, authorize } from "../../../common/auth/authenticate.js";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../../common/tenant.js";
import { listAlerts } from "../../pacing/queries.js";
import { search } from "../../search/search.js";
import { linkedWorkspaces, slackRequestId, type SlackDeps } from "../identity.js";
import { appUrl } from "../slack-config.js";
import { slackApi } from "../slack-api.js";

/**
 * /budget (POST /slack/commands, ADR-046): replies only the person who typed it (ephemeral). Each
 * answer first passes the permission of the app route that gives the same answer (S-001).
 */

const reply = (text: string, blocks?: unknown[]) => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });
const pct = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${Math.round(Number(v) * 100)}%`);
const money = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en", { maximumFractionDigits: 0 }));

const HELP = [
  "*Budget OS* — `/budget` answers only you:",
  "• `/budget alerts` — open alerts you can see",
  "• `/budget search <text>` — budgets, approvals, alerts, targets",
  "• `/budget <budget name>` — a budget's amount, spend and pace",
].join("\n");

export async function handleCommand(prisma: PrismaClient, deps: SlackDeps, raw: unknown): Promise<Record<string, unknown>> {
  const body = (raw ?? {}) as Record<string, string | undefined>;
  const teamId = body["team_id"] ?? "";
  const userId = body["user_id"] ?? "";
  const text = (body["text"] ?? "").trim();
  const api = slackApi();
  if (api === null) return reply("Budget OS is not connected to Slack yet.");
  if (text === "" || text === "help") return reply(HELP);
  const email = await api.userEmail(userId);
  if (!email) return reply("Your Slack profile has no email Budget OS can match.");
  const linked = await linkedWorkspaces(prisma, deps, teamId, email);
  let auth: AuthContext | null = null;
  let chosen: { id: string; name: string } | null = null;
  for (const w of linked) {
    try {
      auth = await authenticateVerifiedEmail(deps, { email, workspaceId: w.id, requestId: slackRequestId() });
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
      authorize(auth, "envelope.read"); // GET /alerts
      const alerts = (await listAlerts(prisma, auth, { limit: "10" })) as Array<{ id: string; severity: string; status: string; envelopeName: string | null; ruleName: string | null }>;
      if (alerts.length === 0) return reply(`No open alerts. :white_check_mark:${footer}`);
      const lines = alerts.map((a) => `• *${a.severity}* <${url(`/alerts?select=${a.id}`)}|${a.envelopeName ?? "Budget"}> — ${a.ruleName ?? "rule"} (${a.status.toLowerCase()})`);
      return reply(`${alerts.length} open alerts${footer}`, [{ type: "section", text: { type: "mrkdwn", text: `*Open alerts*${footer}\n${lines.join("\n")}`.slice(0, 2900) } }]);
    }
    authorize(auth, "workspace.member"); // GET /workspaces/:ws/search
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
