import { shortRequestId } from "@budget/domain";
import { actionButton, button, context, dateRange, esc, header, link, section, type Block } from "@budget/workers";
import { paceOf, percent, wholeMoney } from "./format.js";

/** A budget as a private card (S-009): where it sits, its numbers over its own dates, what waits on it. */
export interface BudgetCardInput {
  baseUrl: string;
  workspaceId: string;
  envelopeId: string;
  name: string;
  path: string | null;
  status: string;
  ended: boolean;
  period: { start: string; end: string };
  reportingCurrency: string;
  ownerName: string | null;
  /** The planner's measures over the budget's dates and everything under it, in the reporting currency. */
  numbers: { budget: string | null; actual: string | null; projected: string | null; spentPct: string | null; paceIndex: string | null } | null;
  /** The approved amount in the budget's own currency, when that is not the reporting currency. */
  own: { amount: string; currency: string } | null;
  openRequest: { id: string; summary: string | null } | null;
  draft: { amount: string; currency: string } | null;
  alerts: Array<{ severity: string; ruleName: string | null; status: string }>;
  children: number;
  notice?: string | null;
  /** S-011: the Request a change button, for someone who may edit and submit this budget. */
  canRequest?: boolean;
}

const STATUS: Record<string, string> = { APPROVED: "Approved", PENDING: "Waiting for approval", DRAFT: "Draft", LOCKED: "Locked (its period is closed)", ARCHIVED: "Archived" };
const SEVERITY: Record<string, string> = { critical: ":rotating_light:", warning: ":warning:", info: ":information_source:", data: ":bar_chart:" };

export function budgetCard(a: BudgetCardInput): { text: string; blocks: Block[] } {
  const n = a.numbers;
  const blocks: Block[] = [];
  if (a.notice) blocks.push(context(a.notice));
  blocks.push(header(a.name));
  const status = a.ended ? "Ended" : (STATUS[a.status] ?? a.status);
  const line = [status, dateRange(a.period.start, a.period.end), a.ownerName ? `owner ${esc(a.ownerName)}` : null].filter((x): x is string => x !== null).join(" · ");
  const cur = a.reportingCurrency;
  blocks.push(
    section(`${a.path ? `*${esc(a.path)}*\n` : ""}${line}`, [
      `*Budget*\n${wholeMoney(n?.budget, cur)}${a.own ? ` (${wholeMoney(a.own.amount, a.own.currency)})` : ""}`,
      `*Spent*\n${wholeMoney(n?.actual, cur)} · ${percent(n?.spentPct)}`,
      `*Projected*\n${wholeMoney(n?.projected, cur)}`,
      `*Pace*\n${paceOf(n?.paceIndex)}`,
    ]),
  );
  if (a.openRequest) blocks.push(section(`:hourglass_flowing_sand: *Waiting for approval:* ${esc((a.openRequest.summary ?? "a change").slice(0, 200))} (${shortRequestId(a.openRequest.id)})\n\`/budget show ${shortRequestId(a.openRequest.id)}\` for the request`));
  else if (a.draft) blocks.push(context(`A draft of ${wholeMoney(a.draft.amount, a.draft.currency)} is not sent for approval yet.`));
  if (a.alerts.length) blocks.push(section(`*Open alerts*\n${a.alerts.map((x) => `• ${SEVERITY[x.severity] ?? ""} ${esc(x.ruleName ?? "Pacing alert")} (${x.status.toLowerCase()})`).join("\n")}`));
  blocks.push({
    type: "actions",
    elements: [button("Open budget", link(a.baseUrl, a.workspaceId, `/budgets?select=${a.envelopeId}`), "open_envelope", "primary"), ...(a.canRequest ? [actionButton("Request a change", "budget.request", a.workspaceId, a.envelopeId)] : [])],
  });
  blocks.push(context(`${a.children ? `${a.children} ${a.children === 1 ? "budget" : "budgets"} under it · ` : ""}Numbers over its dates, in ${cur}`));
  return { text: `${a.name}: ${wholeMoney(n?.budget, cur)} budget, ${percent(n?.spentPct)} spent`, blocks };
}

/** Several budgets match (S-009): one button each; choosing one replaces this message with its card (or, S-011, opens its request form). */
export function whichBudget(a: { workspaceId: string; q: string; hits: Array<{ id: string; title: string; path: string | null }>; actionId?: "budget.show" | "budget.request" }): { text: string; blocks: Block[] } {
  return {
    text: `Which “${a.q}”?`,
    blocks: [
      section(`*Which “${esc(a.q)}”?*\n${a.hits.map((h, i) => `${i + 1}. ${esc(h.title)}${h.path ? ` — _${esc(h.path)}_` : ""}`).join("\n")}`),
      { type: "actions", elements: a.hits.map((h, i) => actionButton(`${i + 1}. ${h.title}`.slice(0, 75), a.actionId ?? "budget.show", a.workspaceId, h.id, undefined, a.actionId === "budget.request" ? undefined : "card")) },
    ],
  };
}

/** /budget list (S-009): budgets with their numbers, each linking to it. */
export function budgetList(a: { baseUrl: string; workspaceId: string; title: string; currency: string; rows: Array<{ id: string | null; label: string; path: string | null; budget: string | null; spentPct: string | null; paceIndex: string | null }>; more: boolean; footer: string }): { text: string; blocks: Block[] } {
  if (a.rows.length === 0) return { text: `${a.title}: none`, blocks: [section(`*${esc(a.title)}*${a.footer}\nNo budgets to show.`)] };
  const lines = a.rows.map((r) => `• ${r.id ? `<${link(a.baseUrl, a.workspaceId, `/budgets?select=${r.id}`)}|${esc(r.label)}>` : esc(r.label)}${r.path ? ` _${esc(r.path)}_` : ""} — ${wholeMoney(r.budget, a.currency)} · spent ${percent(r.spentPct)} · pace ${paceOf(r.paceIndex)}`);
  return {
    text: `${a.title}: ${a.rows.length}${a.more ? "+" : ""}`,
    blocks: [section(`*${esc(a.title)}*${a.footer}\n${lines.join("\n")}`.slice(0, 2900)), ...(a.more ? [context(`<${link(a.baseUrl, a.workspaceId, "/budgets")}|See all of them in BudgetOS>`)] : [])],
  };
}
