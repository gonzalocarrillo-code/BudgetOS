import { actionButton, button, context, esc, header, link, money, section, type SlackMessage } from "./common.js";

/** Approval request / outcome posted to the workspace channel (spec §19 blocks/approval.ts). */
export interface ApprovalMessageInput {
  baseUrl: string;
  workspaceId: string;
  requestId: string;
  kind: "requested" | "approved" | "rejected" | "changes_requested" | "withdrawn" | "escalated";
  subject: string; // envelope name, "Bulk change (24 rows)", "CPA target · BR"
  summary: string;
  requesterName: string;
  deciderName: string | null;
  before: string | null;
  after: string | null;
  currency: string;
  stepRole: string | null;
  policyName: string;
  dueAt: string | null;
  comment: string | null;
  /** Approve / Reject buttons on a request waiting for a decision (the bot is connected). */
  actions?: boolean;
}

const TITLE: Record<ApprovalMessageInput["kind"], string> = {
  requested: "Approval requested",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  withdrawn: "Withdrawn",
  escalated: "Escalated",
};
const ICON: Record<ApprovalMessageInput["kind"], string> = { requested: "📝", approved: "✅", rejected: "⛔", changes_requested: "↩️", withdrawn: "🗑️", escalated: "⏫" };

export function approvalMessage(a: ApprovalMessageInput): SlackMessage {
  const url = link(a.baseUrl, a.workspaceId, `/approvals/${a.requestId}`);
  const fields = [
    `*Requested by*\n${esc(a.requesterName)}`,
    `*Policy*\n${esc(a.policyName)}`,
    ...(a.before !== null || a.after !== null ? [`*Change*\n${money(a.before, a.currency)} → ${money(a.after, a.currency)}`] : []),
    ...(a.kind === "requested" || a.kind === "escalated" ? [`*Waiting on*\n${a.stepRole ?? "—"}${a.dueAt ? `, due ${a.dueAt.slice(0, 10)}` : ""}`] : [`*By*\n${a.deciderName ? esc(a.deciderName) : "—"}`]),
  ];
  return {
    text: `${ICON[a.kind]} ${TITLE[a.kind]}: ${a.subject}`,
    blocks: [
      header(`${ICON[a.kind]} ${TITLE[a.kind]}: ${a.subject}`),
      section(esc(a.summary), fields),
      ...(a.comment ? [section(`> ${esc(a.comment).replace(/\n/g, "\n> ")}`)] : []),
      {
        type: "actions",
        elements: [
          ...(a.actions && (a.kind === "requested" || a.kind === "escalated") ? [actionButton("Approve", "approval.approve", a.workspaceId, a.requestId, "primary"), actionButton("Reject", "approval.reject", a.workspaceId, a.requestId, "danger")] : []),
          button(a.kind === "requested" || a.kind === "escalated" ? "Review" : "Open", url, "open_approval", a.actions ? undefined : "primary"),
        ],
      },
      context(a.actions && (a.kind === "requested" || a.kind === "escalated") ? "Approve or reject here, or review the change in BudgetOS" : "BudgetOS approvals"),
    ],
  };
}
