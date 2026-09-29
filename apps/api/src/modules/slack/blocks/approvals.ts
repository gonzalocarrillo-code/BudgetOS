import { shortRequestId } from "@budget/domain";
import { actionButton, button, context, esc, link, section, type Block } from "@budget/workers";

/** A request waiting on the person (a listApprovals row with assignee=me). */
export interface WaitingRequest {
  id: string;
  summary: string | null;
  requestedByName: string | null;
  requestedAt: string;
  dueAt: string | null;
}

/**
 * /budget approvals (S-006): what waits on the person, newest first, each with Approve / Request
 * changes / Reject and a Review link. The buttons say they sit on this list, so acting replaces it
 * with the list as it is then, led by what happened (`notice`).
 */
export function approvalsList(a: { baseUrl: string; workspaceId: string; rows: WaitingRequest[]; more: boolean; buttons: boolean; notice?: string | null; footer?: string }): { text: string; blocks: Block[] } {
  const n = a.rows.length;
  const blocks: Block[] = [];
  if (a.notice) blocks.push(context(a.notice));
  blocks.push(section(`${n === 0 ? "Nothing is waiting on you. :white_check_mark:" : `*${n}${a.more ? "+" : ""} waiting on you*`}${a.footer ?? ""}`));
  for (const r of a.rows) {
    const meta = [r.requestedByName ? esc(r.requestedByName) : null, `asked ${r.requestedAt.slice(0, 10)}`, r.dueAt ? `due ${r.dueAt.slice(0, 10)}` : null, shortRequestId(r.id)].filter((x): x is string => x !== null).join(" · ");
    blocks.push(section(`*${esc((r.summary ?? "Change").slice(0, 280))}*\n${meta}`));
    blocks.push({
      type: "actions",
      elements: [
        ...(a.buttons
          ? [
              actionButton("Approve", "approval.approve", a.workspaceId, r.id, "primary", "list"),
              actionButton("Request changes", "approval.changes", a.workspaceId, r.id, undefined, "list"),
              actionButton("Reject", "approval.reject", a.workspaceId, r.id, "danger", "list"),
            ]
          : []),
        button("Review", link(a.baseUrl, a.workspaceId, `/approvals/${r.id}`), "open_approval"),
      ],
    });
  }
  if (a.more) blocks.push(context(`<${link(a.baseUrl, a.workspaceId, "/approvals")}|See everything waiting on you in BudgetOS>`));
  return { text: n === 0 ? "Nothing is waiting on you" : `${n}${a.more ? "+" : ""} waiting on you`, blocks };
}
