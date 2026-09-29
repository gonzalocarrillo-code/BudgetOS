import type { SlackActionValue } from "@budget/domain";

/** Slack modals the API opens (views.open) within an interaction's three seconds. */

/** A small form that only says something (a refusal, a result); the person closes it. */
export const messageModal = (title: string, text: string) => ({ type: "modal", title: { type: "plain_text", text: title.slice(0, 24) }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }] });

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
