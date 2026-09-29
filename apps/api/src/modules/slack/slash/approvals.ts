import { DomainError, shortRequestId, type DecisionVerb, type RequestRef } from "@budget/domain";
import { approvalRequestsBySuffix, withTenant } from "@budget/db";
import { approvalCard, context } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../../common/auth/authenticate.js";
import type { AuthContext } from "../../../common/tenant.js";
import { decide } from "../../approvals/commands/decide.js";
import { remindApprovers } from "../../approvals/commands/remind.js";
import { withdrawRequest } from "../../approvals/commands/withdraw.js";
import { getApproval, listApprovals } from "../../approvals/queries/approvals.js";
import { approvalsList, type WaitingRequest } from "../blocks/approvals.js";
import { appUrl, slackSettingsOf } from "../slack-config.js";
import { reply } from "../views.js";

/**
 * /budget approvals, show, approve, reject, changes, withdraw and remind (S-006, S-007): the same
 * queries and commands as the app's inbox and request page, after the same route permissions.
 */

/** Shown at most; the rest are in the app's inbox. */
const LIST_LIMIT = 10;

async function slackSettings(prisma: PrismaClient, auth: AuthContext, workspaceId: string) {
  const ws = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }));
  return slackSettingsOf(ws.settings);
}

/** /budget approvals (S-006): the requests waiting on the caller, as GET /approvals?assignee=me gives them. */
export async function approvalsReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, opts: { notice?: string | null; footer?: string } = {}): Promise<Record<string, unknown>> {
  authorize(auth, "workspace.member"); // GET /approvals
  const res = await listApprovals(prisma, auth, { assignee: "me", limit: String(LIST_LIMIT) });
  const s = await slackSettings(prisma, auth, workspaceId);
  const list = approvalsList({ baseUrl: appUrl(), workspaceId, rows: res.rows as unknown as WaitingRequest[], more: res.nextCursor !== null, buttons: s.approvals !== false, notice: opts.notice ?? null, ...(opts.footer ? { footer: opts.footer } : {}) });
  return { response_type: "ephemeral", ...list };
}

/**
 * /budget show #id (S-007): one request as a private card, as GET /approvals/:id reads it (scope
 * checked). Its buttons show only when the caller may decide the step now; otherwise it says why.
 */
export async function requestCard(prisma: PrismaClient, auth: AuthContext, workspaceId: string, requestId: string, notice?: string | null): Promise<Record<string, unknown>> {
  authorize(auth, "envelope.read"); // GET /approvals/:id
  const detail = await getApproval(prisma, auth, requestId);
  const s = await slackSettings(prisma, auth, workspaceId);
  const card = await withTenant(prisma, auth.ctx, (tx) => approvalCard(tx, workspaceId, requestId, appUrl(), s, { actions: detail.decision.canDecide }));
  if (card === null) throw new DomainError("NOT_FOUND", "Request not found");
  const open = detail.status === "PENDING" || detail.status === "ESCALATED";
  const blocks = [
    ...(notice ? [context(notice)] : []),
    ...card.blocks,
    ...(open && !detail.decision.canDecide && detail.decision.reason ? [context(`You cannot decide it: ${detail.decision.reason}.`)] : []),
  ];
  return { response_type: "ephemeral", text: card.text, blocks };
}

/** The id of the request a `/budget show` reference names. */
export async function decisionTarget(prisma: PrismaClient, auth: AuthContext, ref: RequestRef): Promise<string> {
  return (await resolveRequest(prisma, auth, ref)).id;
}

/** The request a reference names in this workspace (row security): one, or a refusal that says why. */
async function resolveRequest(prisma: PrismaClient, auth: AuthContext, ref: RequestRef): Promise<{ id: string; summary: string }> {
  const rows = await withTenant(prisma, auth.ctx, async (tx) => {
    if (ref.kind === "suffix") return approvalRequestsBySuffix(tx, ref.suffix);
    const r = await tx.approvalRequest.findUnique({ where: { id: ref.id }, select: { id: true, summary: true, status: true } });
    return r ? [r] : [];
  });
  const label = ref.kind === "suffix" ? `#${ref.suffix}` : shortRequestId(ref.id);
  if (rows.length === 0) throw new DomainError("NOT_FOUND", `No request ${label} in this workspace. \`/budget approvals\` lists yours.`);
  if (rows.length > 1) throw new DomainError("CONFLICT", `${label} matches ${rows.length} requests: paste the full link from BudgetOS instead.`);
  return rows[0] as { id: string; summary: string };
}

const EXAMPLE: Record<DecisionVerb, string> = {
  approve: "/budget approve #a1b2c3d4",
  reject: "/budget reject #a1b2c3d4 <why>",
  changes: "/budget changes #a1b2c3d4 <what should change>",
  withdraw: "/budget withdraw #a1b2c3d4",
  remind: "/budget remind #a1b2c3d4",
};

const WAITING_ON = (status: string) => (status === "APPROVED" ? "It is approved." : status === "PENDING" || status === "ESCALATED" ? "It now waits on the next step." : "");

/**
 * /budget approve | reject | changes | withdraw | remind #id [text] (S-007): the app's commands with
 * channel "slack". The notify worker then edits every message about the request and tells the
 * people concerned; the reply here is for the person who typed it.
 */
export async function decisionCommand(prisma: PrismaClient, auth: AuthContext, verb: DecisionVerb, ref: RequestRef | null, text: string): Promise<Record<string, unknown>> {
  if (ref === null) return reply(`Which request? Name it by its id, as in \`${EXAMPLE[verb]}\`. \`/budget approvals\` lists yours.`);
  if ((verb === "reject" || verb === "changes") && text.trim() === "") return reply(`Say ${verb === "reject" ? "why" : "what should change"}; the requester sees it: \`${EXAMPLE[verb]}\`.`);
  const r = await resolveRequest(prisma, auth, ref);
  const label = `*${r.summary.slice(0, 200)}* (${shortRequestId(r.id)})`;
  const comment = text.trim() === "" ? {} : { comment: text.trim() };
  switch (verb) {
    case "approve": {
      authorize(auth, "approval.decide"); // POST /approvals/:id/decisions
      const res = await decide(prisma, auth, r.id, { decision: "approve", channel: "slack", ...comment });
      return reply(`:white_check_mark: Approved ${label}. ${WAITING_ON(res.status)}`.trim());
    }
    case "reject":
      authorize(auth, "approval.decide");
      await decide(prisma, auth, r.id, { decision: "reject", channel: "slack", ...comment });
      return reply(`:no_entry: Rejected ${label}. The requester sees your reason.`);
    case "changes":
      authorize(auth, "approval.decide");
      await decide(prisma, auth, r.id, { decision: "request_changes", channel: "slack", ...comment });
      return reply(`:leftwards_arrow_with_hook: Changes requested on ${label}. The requester resolves the thread before sending it again.`);
    case "withdraw":
      authorize(auth, "envelope.submit"); // POST /approvals/:id/withdraw
      await withdrawRequest(prisma, auth, r.id, comment);
      return reply(`:wastebasket: Withdrew ${label}.`);
    case "remind": {
      authorize(auth, "envelope.submit"); // who may send a request may remind its approvers
      const res = await remindApprovers(prisma, auth, r.id);
      return reply(`:alarm_clock: Reminded the approvers of step ${res.step + 1} of ${label}.`);
    }
  }
}
