import { actionButton, button, context, esc, header, link, money, section, type SlackMessage } from "./common.js";

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
  /** Where the alert is now (the message is edited when it changes) and who moved it there. */
  status?: "OPEN" | "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED";
  statusBy?: string | null;
  snoozedUntil?: string | null;
  /** Show the Acknowledge / Snooze / Resolve buttons (the bot is connected with interactivity). */
  actions?: boolean;
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
      ...(a.status && a.status !== "OPEN" ? [context(statusLine(a))] : []),
      {
        type: "actions",
        elements: [
          ...(a.actions && a.status !== "RESOLVED"
            ? [
                ...(a.status !== "ACKNOWLEDGED" && a.status !== "SNOOZED" ? [actionButton("Acknowledge", "alert.acknowledge", a.workspaceId, a.alertId)] : []),
                ...(a.status !== "SNOOZED" ? [actionButton("Snooze a week", "alert.snooze", a.workspaceId, a.alertId)] : []),
                actionButton("Resolve", "alert.resolve", a.workspaceId, a.alertId),
              ]
            : []),
          button("Open alert", url, "open_alert", a.actions ? undefined : "primary"),
          button("Open budget", link(a.baseUrl, a.workspaceId, `/budgets?select=${a.envelopeId}`), "open_envelope"),
        ],
      },
      context(`Evaluated for ${a.evaluatedFor}`, "BudgetOS pacing"),
    ],
  };
}

function statusLine(a: AlertMessageInput): string {
  const by = a.statusBy ? ` by ${esc(a.statusBy)}` : "";
  if (a.status === "ACKNOWLEDGED") return `:eyes: Acknowledged${by}`;
  if (a.status === "SNOOZED") return `:zzz: Snoozed${by}${a.snoozedUntil ? ` until ${a.snoozedUntil.slice(0, 10)}` : ""}`;
  if (a.status === "RESOLVED") return `:white_check_mark: Resolved${by}`;
  return "";
}
