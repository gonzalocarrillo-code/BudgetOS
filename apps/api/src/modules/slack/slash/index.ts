import { parseSlackCommand } from "@budget/domain";
import { log } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../../common/auth/authenticate.js";
import { listAlerts } from "../../pacing/queries.js";
import { search } from "../../search/search.js";
import { chooseWorkspace, type SlackDeps } from "../identity.js";
import { appUrl } from "../slack-config.js";
import { slackResponder } from "../respond.js";
import { slackApi } from "../slack-api.js";
import { messageOf, reply } from "../views.js";
import { approvalsReply, decisionCommand, decisionTarget, requestCard } from "./approvals.js";
import { budgetReply, listReply } from "./budgets.js";
import { requestReply } from "./request.js";
import { summaryReply } from "./summary.js";
import { workspaceReply } from "./workspace.js";

/**
 * /budget (POST /slack/commands, ADR-046, ADR-065): replies only the person who typed it
 * (ephemeral). The text is read by parseSlackCommand (@budget/domain); each answer first passes the
 * permission of the app route that gives the same answer.
 */

const pct = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${Math.round(Number(v) * 100)}%`);
const money = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en", { maximumFractionDigits: 0 }));

export const HELP = [
  "*BudgetOS* — `/budget` answers only you:",
  "• `/budget` — your summary: the year so far, what waits on you, your budgets",
  "• `/budget approvals` — requests waiting on you, with Approve / Request changes / Reject",
  "• `/budget show #a1b2c3d4` — one request (its id is on every request message)",
  "• `/budget approve #a1b2c3d4 [comment]` · `reject #… <why>` · `changes #… <what>`",
  "• `/budget withdraw #…` · `remind #…` — your own requests",
  "• `/budget alerts` — open alerts you can see",
  "• `/budget search <text>` — budgets, approvals, alerts, targets",
  "• `/budget <budget name>` — a budget's card: amount, spend, projected, pace, what waits on it",
  "• `/budget list [text]` — the top-level budgets this fiscal year, or those matching the text",
  "• `/budget request <budget name>` — a form to send a new amount for approval",
  "• `/budget workspace [name]` — which workspace /budget answers for, and choosing another",
].join("\n");

/** Slack waits three seconds for a command's answer; past this, the answer follows through response_url (S-012). */
const ANSWER_WITHIN_MS = 2_500;
let deadlineMs = ANSWER_WITHIN_MS;
/** Tests: a shorter wait before "Working on it…" (undefined puts the real one back). */
export function setCommandDeadline(ms: number | undefined): void {
  deadlineMs = ms ?? ANSWER_WITHIN_MS;
}

/**
 * POST /slack/commands. The answer comes within Slack's three seconds when it can; a slower one
 * (a large workspace, a cold start) is acknowledged with "Working on it…" and sent through the
 * command's response_url once ready, replacing that line (ADR-063). Deployed, the API must keep
 * CPU after answering for that to finish (Cloud Run: CPU always allocated).
 */
export async function handleCommand(prisma: PrismaClient, deps: SlackDeps, raw: unknown): Promise<Record<string, unknown>> {
  const body = (raw ?? {}) as Record<string, string | undefined>;
  const work = answer(prisma, deps, body).catch((e: unknown) => reply(`:no_entry: ${messageOf(e)}`));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  const first = await Promise.race([work, late]);
  clearTimeout(timer);
  if (first !== "late") return first;
  const responseUrl = body["response_url"];
  if (!responseUrl) return work; // nowhere to send it later: Slack may time out, but the person gets it if it can
  void work.then((answered) => slackResponder().respond(responseUrl, { replace_original: true, ...answered })).catch((err: unknown) => log.error({ err, command: body["command"], userId: body["user_id"] }, "slack: a late /budget answer could not be sent"));
  return reply(":hourglass_flowing_sand: Working on it…");
}

async function answer(prisma: PrismaClient, deps: SlackDeps, body: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const teamId = body["team_id"] ?? "";
  const userId = body["user_id"] ?? "";
  const cmd = parseSlackCommand(body["text"] ?? "");
  const api = slackApi();
  if (api === null) return reply("BudgetOS is not connected to Slack yet.");
  if (cmd.verb === "help") return reply(HELP);
  const email = await api.userEmail(userId);
  if (!email) return reply("Your Slack profile has no email BudgetOS can match.");
  // S-010: the workspace whose channel this is, else the person's choice, else their only one.
  const chosen = await chooseWorkspace(prisma, deps, { teamId, email, channelId: body["channel_id"], channelName: body["channel_name"] });
  if (chosen === null) return reply("No BudgetOS workspace linked to this Slack workspace gives you access. An admin links one in Admin › Slack.");
  const auth = chosen.auth;
  const ws = chosen.workspace.id;
  const url = (path: string) => `${appUrl()}/w/${ws}${path}`;
  const footer = chosen.mine.length > 1 ? ` · workspace *${chosen.workspace.name}*${chosen.how === "first" ? " (`/budget workspace` to choose)" : ""}` : "";
  try {
    switch (cmd.verb) {
      case "summary":
        return await summaryReply(prisma, auth, ws, footer);
      case "approvals":
        return await approvalsReply(prisma, auth, ws, { footer });
      case "show": {
        const found = await decisionTarget(prisma, auth, cmd.ref);
        return await requestCard(prisma, auth, ws, found);
      }
      case "approve":
      case "reject":
      case "changes":
      case "withdraw":
      case "remind":
        return await decisionCommand(prisma, auth, cmd.verb, cmd.ref, cmd.text);
      case "alerts": {
        authorize(auth, "envelope.read"); // GET /alerts
        const alerts = (await listAlerts(prisma, auth, { limit: "10" })) as Array<{ id: string; severity: string; status: string; envelopeName: string | null; ruleName: string | null }>;
        if (alerts.length === 0) return reply(`No open alerts. :white_check_mark:${footer}`);
        const lines = alerts.map((a) => `• *${a.severity}* <${url(`/alerts?select=${a.id}`)}|${a.envelopeName ?? "Budget"}> — ${a.ruleName ?? "rule"} (${a.status.toLowerCase()})`);
        return reply(`${alerts.length} open alerts${footer}`, [{ type: "section", text: { type: "mrkdwn", text: `*Open alerts*${footer}\n${lines.join("\n")}`.slice(0, 2900) } }]);
      }
      case "budget":
        if (cmd.text === "") return reply(HELP);
        return await budgetReply(prisma, auth, ws, cmd.text, footer);
      case "list":
        return await listReply(prisma, auth, ws, cmd.text, footer);
      case "search": {
        authorize(auth, "workspace.member"); // GET /workspaces/:ws/search
        if (cmd.text === "") return reply(HELP);
        const res = await search(prisma, auth, { q: cmd.text, limit: "5" });
        const groups = res.groups as Array<{ type: string; count: number; hits: Array<{ title: string; path: string | null; deepLink: string; facets?: Record<string, unknown> | null }> }>;
        if (groups.length === 0) return reply(`Nothing matches “${cmd.text}”.${footer}`);
        const lines = groups.flatMap((g) =>
          g.hits.map((h) => {
            const f = h.facets ?? {};
            const numbers = g.type === "envelope" ? ` — budget ${money(f["budget"])}, spent ${money(f["actual"])}${f["budget"] ? ` (${pct(Number(f["actual"] ?? 0) / Number(f["budget"]))})` : ""}${f["pace_index"] !== undefined && f["pace_index"] !== null ? `, pace ${Number(f["pace_index"]).toFixed(2)}` : ""}` : "";
            return `• <${appUrl()}${h.deepLink}|${h.title}>${h.path ? ` _${h.path}_` : ""}${numbers}`;
          }),
        );
        return reply(`Results for “${cmd.text}”${footer}`, [{ type: "section", text: { type: "mrkdwn", text: `*Search: ${cmd.text}*${footer}\n${lines.join("\n")}`.slice(0, 2900) } }]);
      }
      case "workspace":
        return await workspaceReply(prisma, chosen, cmd.text);
      case "request":
        return await requestReply(prisma, auth, ws, cmd.text, body["trigger_id"], footer);
    }
  } catch (e) {
    return reply(`:no_entry: ${messageOf(e)}`);
  }
}
