/** Block Kit helpers (spec §19). Messages carry text for notifications and blocks for the layout. */

export interface SlackMessage {
  text: string;
  blocks: Block[];
}

export type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "section"; text: { type: "mrkdwn"; text: string }; fields?: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "actions"; elements: Array<{ type: "button"; text: { type: "plain_text"; text: string; emoji: true }; url: string; action_id: string; style?: "primary" | "danger" }> }
  | { type: "divider" };

/** Escapes the three characters Slack mrkdwn treats as control characters. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Deep links always point at the web app (`https://<host>/w/<ws>/...`). */
export const link = (baseUrl: string, workspaceId: string, path: string) => `${baseUrl.replace(/\/$/, "")}/w/${workspaceId}${path}`;

export const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } });
export const section = (text: string, fields?: string[]): Block => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) }, ...(fields?.length ? { fields: fields.slice(0, 10).map((f) => ({ type: "mrkdwn" as const, text: f.slice(0, 2000) })) } : {}) });
export const context = (...parts: string[]): Block => ({ type: "context", elements: parts.filter(Boolean).map((text) => ({ type: "mrkdwn" as const, text })) });
export const button = (text: string, url: string, actionId: string, style?: "primary" | "danger") => ({ type: "button" as const, text: { type: "plain_text" as const, text, emoji: true as const }, url, action_id: actionId, ...(style ? { style } : {}) });

/** Money for Slack: grouped thousands and the currency code; the value stays a decimal string. */
export function money(amount: string | null, currency: string): string {
  if (amount === null) return "—";
  const [int = "0", frac] = amount.replace(/^-/, "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount.startsWith("-") ? "−" : ""}${currency} ${grouped}${frac !== undefined ? `.${frac.padEnd(2, "0").slice(0, 2)}` : ""}`;
}
