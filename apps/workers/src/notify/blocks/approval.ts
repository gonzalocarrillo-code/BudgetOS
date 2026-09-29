import { shortRequestId } from "@budget/domain";
import { actionButton, button, context, dateRange, esc, header, link, money, pctChange, section, type SlackMessage } from "./common.js";

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
  /** Approve / Request changes / Reject buttons on a request waiting for a decision (the bot is connected). */
  actions?: boolean;
  /** S-005: where the budget sits (Region › Country › …), its dates, the requester's reason, and which step of how many. */
  path?: string | null;
  period?: { start: string; end: string } | null;
  rationale?: string | null;
  step?: { index: number; count: number } | null;
  /** The private message its buttons sit on (S-007: a /budget show card), so the API replaces it after acting. */
  origin?: "list" | "card";
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

const role = (r: string | null) => (r ? r.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");

export function approvalMessage(a: ApprovalMessageInput): SlackMessage {
  const url = link(a.baseUrl, a.workspaceId, `/approvals/${a.requestId}`);
  const open = a.kind === "requested" || a.kind === "escalated";
  const delta = pctChange(a.before, a.after);
  const step = a.step && a.step.count > 1 ? ` (step ${a.step.index + 1} of ${a.step.count})` : "";
  const fields = [
    `*Requested by*\n${esc(a.requesterName)}`,
    `*Policy*\n${esc(a.policyName)}`,
    ...(a.before !== null || a.after !== null ? [`*Change*\n${money(a.before, a.currency)} → ${money(a.after, a.currency)}${delta ? ` (${delta})` : ""}`] : []),
    ...(open ? [`*Waiting on*\n${role(a.stepRole)}${step}${a.dueAt ? `, due ${a.dueAt.slice(0, 10)}` : ""}`] : [`*By*\n${a.deciderName ? esc(a.deciderName) : "—"}`]),
    ...(a.period ? [`*Period*\n${dateRange(a.period.start, a.period.end)}`] : []),
  ];
  // The budget's place in the tree, then why it changes (the requester's words, else the summary).
  const text = a.path ? `*${esc(a.path)}*\n${esc(a.rationale ? `“${a.rationale}”` : a.summary)}` : esc(a.summary);
  return {
    text: `${ICON[a.kind]} ${TITLE[a.kind]}: ${a.subject}`,
    blocks: [
      header(`${ICON[a.kind]} ${TITLE[a.kind]}: ${a.subject}`),
      section(text, fields),
      ...(a.comment ? [section(`> ${esc(a.comment).replace(/\n/g, "\n> ")}`)] : []),
      {
        type: "actions",
        elements: [
          ...(a.actions && open
            ? [
                actionButton("Approve", "approval.approve", a.workspaceId, a.requestId, "primary", a.origin),
                actionButton("Request changes", "approval.changes", a.workspaceId, a.requestId, undefined, a.origin),
                actionButton("Reject", "approval.reject", a.workspaceId, a.requestId, "danger", a.origin),
              ]
            : []),
          button(open ? "Review" : "Open", url, "open_approval", a.actions ? undefined : "primary"),
        ],
      },
      context(`Request ${shortRequestId(a.requestId)}`, a.actions && open ? "Decide here, or review the change in BudgetOS" : "BudgetOS approvals"),
    ],
  };
}

/** A reminder (S-004): the request's message, led by who sent it; posted to each approver as a new direct message. */
export function approvalReminder(m: SlackMessage, byName: string | null): SlackMessage {
  return {
    text: `⏰ Reminder: ${m.text}`,
    blocks: [context(`⏰ ${byName ? `${esc(byName)} sent a reminder` : "A reminder"}: this request is waiting on you.`), ...m.blocks],
  };
}
