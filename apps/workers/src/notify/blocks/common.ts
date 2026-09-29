import { Decimal } from "decimal.js";

/** Block Kit helpers (spec §19). Messages carry text for notifications and blocks for the layout. */

export interface SlackMessage {
  text: string;
  blocks: Block[];
}

export type Block =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: true } }
  | { type: "section"; text: { type: "mrkdwn"; text: string }; fields?: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "actions"; elements: Array<Button> }
  | { type: "divider" };

/** A link button (opens Budget OS) or an action button (the bot acts: `value` names the workspace and entity). */
export type Button = { type: "button"; text: { type: "plain_text"; text: string; emoji: true }; action_id: string; style?: "primary" | "danger" } & ({ url: string } | { value: string });

/** Escapes the three characters Slack mrkdwn treats as control characters. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Deep links always point at the web app (`https://<host>/w/<ws>/...`). */
export const link = (baseUrl: string, workspaceId: string, path: string) => `${baseUrl.replace(/\/$/, "")}/w/${workspaceId}${path}`;

export const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } });
export const section = (text: string, fields?: string[]): Block => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) }, ...(fields?.length ? { fields: fields.slice(0, 10).map((f) => ({ type: "mrkdwn" as const, text: f.slice(0, 2000) })) } : {}) });
export const context = (...parts: string[]): Block => ({ type: "context", elements: parts.filter(Boolean).map((text) => ({ type: "mrkdwn" as const, text })) });
export const button = (text: string, url: string, actionId: string, style?: "primary" | "danger"): Button => ({ type: "button" as const, text: { type: "plain_text" as const, text, emoji: true as const }, url, action_id: actionId, ...(style ? { style } : {}) });
/**
 * A button the bot handles (POST /slack/interactions): acknowledge, snooze, resolve, approve, reject,
 * request changes. `origin` says which private (ephemeral) message it sits on, so the API can
 * replace that message after acting (S-006); messages the worker posted leave it out.
 */
export const actionButton = (text: string, actionId: string, workspaceId: string, id: string, style?: "primary" | "danger", origin?: "list" | "card"): Button => ({ type: "button" as const, text: { type: "plain_text" as const, text, emoji: true as const }, action_id: actionId, value: JSON.stringify({ ws: workspaceId, id, ...(origin ? { o: origin } : {}) }), ...(style ? { style } : {}) });

/** Money for Slack: grouped thousands and the currency code; the value stays a decimal string. */
export function money(amount: string | null, currency: string): string {
  if (amount === null) return "—";
  const [int = "0", frac] = amount.replace(/^-/, "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount.startsWith("-") ? "−" : ""}${currency} ${grouped}${frac !== undefined ? `.${frac.padEnd(2, "0").slice(0, 2)}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Business dates (YYYY-MM-DD) as "1 Jan – 31 Dec 2026", or with both years when they differ. */
export function dateRange(start: string, end: string): string {
  const day = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? "?"}`;
  const ys = start.slice(0, 4);
  const ye = end.slice(0, 4);
  return ys === ye ? `${day(start)} – ${day(end)} ${ye}` : `${day(start)} ${ys} – ${day(end)} ${ye}`;
}

/** The change from one decimal amount to another as a signed percentage ("+15.0%"), or null when there is no base. */
export function pctChange(before: string | null, after: string | null): string | null {
  if (before === null || after === null) return null;
  const b = new Decimal(before);
  if (b.isZero()) return null;
  const pct = new Decimal(after).minus(b).div(b.abs()).mul(100).toDecimalPlaces(1);
  return `${pct.isNegative() ? "−" : "+"}${pct.abs().toFixed(1)}%`;
}
