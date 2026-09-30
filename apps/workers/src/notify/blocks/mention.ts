import { button, context, esc, header, section, type SlackMessage } from "./common.js";

/** Direct message to a mentioned user (spec §19 blocks/mention.ts). */
export interface MentionMessageInput {
  baseUrl: string;
  workspaceId: string;
  commentId: string;
  /** Where the thread is read and answered (threadPath in @budget/domain), from the app's origin. */
  threadPath: string;
  authorName: string;
  anchorLabel: string; // "LATAM › Brazil › Meta", "Approval · …"
  threadTitle: string | null;
  bodyMd: string;
  /** Display names for the canonical @[user|group:id] tokens in the body. */
  names: Record<string, string>;
}

/** Canonical mention tokens become @Name; references become their type. */
export function renderBody(bodyMd: string, names: Record<string, string>): string {
  return bodyMd
    .replace(/@\[(user|group):([0-9a-f-]{36})\]/g, (_, _t: string, id: string) => `@${names[id] ?? "someone"}`)
    .replace(/#\[(envelope|target|alert|request):[0-9a-f-]{36}\]/g, (_, t: string) => `#${t}`);
}

export function mentionMessage(m: MentionMessageInput): SlackMessage {
  const body = renderBody(m.bodyMd, m.names);
  const excerpt = body.length > 500 ? `${body.slice(0, 497)}…` : body;
  const url = `${m.baseUrl.replace(/\/$/, "")}${m.threadPath}`;
  return {
    text: `${m.authorName} mentioned you on ${m.anchorLabel}`,
    blocks: [
      header(`💬 ${m.authorName} mentioned you`),
      section(`*${esc(m.threadTitle ?? m.anchorLabel)}*\n${esc(excerpt).replace(/^/gm, "> ")}`),
      { type: "actions", elements: [button("Reply in BudgetOS", url, "open_thread", "primary")] },
      context(esc(m.anchorLabel)),
    ],
  };
}
