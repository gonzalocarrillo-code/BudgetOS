import { DomainError, type SlackActionValue } from "@budget/domain";

/** Slack modals the API opens (views.open) within an interaction's three seconds, and the text of private replies. */

/** A private reply to a command: only the person who typed it sees it. */
export const reply = (text: string, blocks?: unknown[]) => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });

/** What to tell the person: the command's message, or, when the input was refused, its first problem ("Comment required…"). */
export function messageOf(e: unknown): string {
  if (e instanceof DomainError && e.code === "VALIDATION") {
    const issues = e.details?.["issues"] as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } | undefined;
    const first = issues?.formErrors?.[0] ?? Object.values(issues?.fieldErrors ?? {}).flat()[0];
    if (first) return first;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A small form that only says something (a refusal, a result); the person closes it. */
export const messageModal = (title: string, text: string) => ({ type: "modal", title: { type: "plain_text", text: title.slice(0, 24) }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }] });

/** Request changes (S-005): the comment opens a blocking thread the requester resolves before sending it again. */
export function changesForm(value: SlackActionValue): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "approval.changes",
    private_metadata: JSON.stringify(value),
    title: { type: "plain_text", text: "Request changes" },
    submit: { type: "plain_text", text: "Request changes" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "comment", label: { type: "plain_text", text: "What should change?" }, element: { type: "plain_text_input", action_id: "comment", multiline: true, min_length: 3 } },
      { type: "context", elements: [{ type: "mrkdwn", text: "The requester sees this in a thread on the budget, and resolves it before sending the change again." }] },
    ],
  };
}

/** Request a change to a budget (S-011): its new amount and why, sent through the approval policy. */
export function requestForm(state: { ws: string; id: string; base: string | null }, info: { title: string; now: string; currency: string }): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "budget.request",
    private_metadata: JSON.stringify(state),
    title: { type: "plain_text", text: "Request a change" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${info.title.slice(0, 200)}*\nNow: ${info.now}` } },
      { type: "input", block_id: "amount", label: { type: "plain_text", text: `New amount (${info.currency})` }, element: { type: "plain_text_input", action_id: "amount", placeholder: { type: "plain_text", text: "e.g. 120,000 or 120000.50" } } },
      { type: "input", block_id: "why", label: { type: "plain_text", text: "Why? (the approvers see this)" }, element: { type: "plain_text_input", action_id: "why", multiline: true, min_length: 3 } },
      { type: "context", elements: [{ type: "mrkdwn", text: "It goes through the approval policy, as in BudgetOS. An admin's own change applies at once." }] },
    ],
  };
}

export function rejectForm(value: SlackActionValue): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "approval.reject",
    private_metadata: JSON.stringify(value),
    title: { type: "plain_text", text: "Reject request" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "reason", label: { type: "plain_text", text: "Why? (the requester sees this)" }, element: { type: "plain_text_input", action_id: "reason", multiline: true, min_length: 3 } }],
  };
}
