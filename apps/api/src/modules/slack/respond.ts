import { DomainError } from "@budget/domain";

/**
 * Answers Slack about the interaction the API is handling, through that interaction's
 * response_url (ADR-065): it replaces the private message a button sat on, or delivers a slash
 * command's late answer. It never posts to a channel; the notify worker does that. A response_url
 * is valid for thirty minutes and five uses, and is only ever a hooks.slack.com address.
 */
export interface SlackResponder {
  respond(responseUrl: string, body: Record<string, unknown>): Promise<void>;
}

const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\//;

class FetchResponder implements SlackResponder {
  async respond(responseUrl: string, body: Record<string, unknown>): Promise<void> {
    if (!RESPONSE_URL.test(responseUrl)) throw new DomainError("VALIDATION", "Not a Slack response_url");
    const res = await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2_500) });
    if (!res.ok) throw new DomainError("UNAVAILABLE", `Slack answered ${res.status} to the response_url`);
  }
}

let override: SlackResponder | undefined;
let real: SlackResponder | undefined;
export function slackResponder(): SlackResponder {
  return override ?? (real ??= new FetchResponder());
}
/** Tests: a fake responder (undefined puts the real one back). */
export function setSlackResponder(responder: SlackResponder | undefined): void {
  override = responder;
}
