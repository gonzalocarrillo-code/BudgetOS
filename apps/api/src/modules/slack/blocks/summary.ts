import { button, context, dateRange, esc, link, section, type Block } from "@budget/workers";
import { Decimal } from "decimal.js";
import { paceOf, percent, wholeMoney } from "./format.js";

/** What /budget shows (S-008): a narrow view of GET /me/home, so Home's changes reach Slack through one adapter. */
export interface SummaryInput {
  baseUrl: string;
  workspaceId: string;
  personName: string;
  footer: string;
  workspaceName: string | null;
  currency: string;
  period: { start: string; end: string; elapsed: string | null } | null;
  totals: { budget: string | null; actual: string | null; spentPct: string | null; openAlerts: number } | null;
  waiting: { approvals: number; alerts: number; mentions: number };
  budgets: Array<{ label: string; envelopeId?: string | undefined; budget: string | null; spentPct: string | null; paceIndex: string | null }>;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryMessage(a: SummaryInput): { text: string; blocks: Block[] } {
  const blocks: Block[] = [];
  // Totals over nothing (a scope that holds no budget) are not shown.
  const totals = a.totals && a.totals.budget !== null && !new Decimal(a.totals.budget).isZero() ? a.totals : null;
  const title = `*${esc(a.workspaceName ?? "BudgetOS")}* · ${esc(a.personName)}${a.footer}`;
  const year = a.period ? `\nThis fiscal year, ${dateRange(a.period.start, a.period.end)}${a.period.elapsed ? `: ${percent(a.period.elapsed)} of it gone` : ""}` : "";
  blocks.push(section(`${title}${year}`, totals ? [`*Budget*\n${wholeMoney(totals.budget, a.currency)}`, `*Spent*\n${wholeMoney(totals.actual, a.currency)} (${percent(totals.spentPct)})`, `*Open alerts*\n${totals.openAlerts}`] : undefined));
  const waiting = [a.waiting.approvals ? count(a.waiting.approvals, "approval", "approvals") : null, a.waiting.alerts ? count(a.waiting.alerts, "alert", "alerts") : null, a.waiting.mentions ? count(a.waiting.mentions, "mention", "mentions") : null].filter((x): x is string => x !== null);
  blocks.push(section(waiting.length ? `:inbox_tray: *Waiting on you:* ${waiting.join(" · ")}${a.waiting.approvals ? "\n`/budget approvals` to decide them here" : ""}` : "Nothing is waiting on you. :white_check_mark:"));
  if (a.budgets.length) {
    const lines = a.budgets.map((b) => `• ${b.envelopeId ? `<${link(a.baseUrl, a.workspaceId, `/budgets?select=${b.envelopeId}`)}|${esc(b.label)}>` : esc(b.label)} ${wholeMoney(b.budget, a.currency)} · spent ${percent(b.spentPct)} · pace ${paceOf(b.paceIndex)}`);
    blocks.push(section(`*Your budgets*\n${lines.join("\n")}`));
  } else if (totals === null) {
    blocks.push(section("Nothing to show yet: no budgets you can read in this workspace."));
  }
  blocks.push({ type: "actions", elements: [button("Open BudgetOS", link(a.baseUrl, a.workspaceId, ""), "open_home", "primary"), button("Approvals", link(a.baseUrl, a.workspaceId, "/approvals"), "open_approvals")] });
  blocks.push(context("`/budget help` for everything /budget answers"));
  return { text: `${a.workspaceName ?? "BudgetOS"}: ${totals ? `${wholeMoney(totals.budget, a.currency)} budget, ${percent(totals.spentPct)} spent` : "your summary"}`, blocks };
}
