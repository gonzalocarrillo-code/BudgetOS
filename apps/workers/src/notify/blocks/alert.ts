import { button, context, esc, header, link, money, section, type SlackMessage } from "./common.js";

/** Alert posted to a rule's channel (spec §19 blocks/alert.ts). */
export interface AlertMessageInput {
  baseUrl: string;
  workspaceId: string;
  alertId: string;
  envelopeId: string;
  ruleName: string;
  severity: "info" | "warning" | "critical" | "data";
  metric: string;
  metricValue: string;
  comparator: string;
  threshold: string;
  envelopePath: string;
  budget: string | null;
  actual: string | null;
  currency: string;
  ownerName: string | null;
  reopened: boolean;
  evaluatedFor: string;
}

const ICON = { info: ":information_source:", warning: ":warning:", critical: ":rotating_light:", data: ":bar_chart:" } as const;
const CMP: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };

export function alertMessage(a: AlertMessageInput): SlackMessage {
  const title = `${a.reopened ? "Reopened: " : ""}${a.ruleName}`;
  const url = link(a.baseUrl, a.workspaceId, `/alerts?select=${a.alertId}`);
  return {
    text: `${ICON[a.severity]} ${title} — ${a.envelopePath}`,
    blocks: [
      header(`${a.severity === "critical" ? "🚨" : "⚠️"} ${title}`),
      section(`*${esc(a.envelopePath)}*\n\`${a.metric}\` is *${a.metricValue}* (rule: ${CMP[a.comparator] ?? a.comparator} ${a.threshold})`, [
        `*Severity*\n${a.severity}`,
        `*Owner*\n${a.ownerName ? esc(a.ownerName) : "Unassigned"}`,
        `*Budget*\n${money(a.budget, a.currency)}`,
        `*Actual*\n${money(a.actual, a.currency)}`,
      ]),
      { type: "actions", elements: [button("Open alert", url, "open_alert", "primary"), button("Open envelope", link(a.baseUrl, a.workspaceId, `/budgets?select=${a.envelopeId}`), "open_envelope")] },
      context(`Evaluated for ${a.evaluatedFor}`, "Budget OS pacing"),
    ],
  };
}
