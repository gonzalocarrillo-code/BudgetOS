import { WebClient } from "@slack/web-api";

/**
 * What the API itself asks Slack, all within Slack's three-second window for interactions:
 * who a Slack user is (their email, to find their Budget OS account), opening a form (the reject
 * reason; its trigger expires in 3 s), and which Slack team the bot is in (linking a workspace).
 * Every message the bot posts or edits goes through the outbox and the notify worker (ADR-046).
 */
export interface SlackApi {
  userEmail(slackUserId: string): Promise<string | null>;
  openView(triggerId: string, view: Record<string, unknown>): Promise<void>;
  team(): Promise<{ id: string; name: string } | null>;
}

class WebApiSlackApi implements SlackApi {
  private readonly client: WebClient;
  private readonly emails = new Map<string, { email: string | null; at: number }>();
  constructor(token: string) {
    this.client = new WebClient(token);
  }
  async userEmail(slackUserId: string): Promise<string | null> {
    const hit = this.emails.get(slackUserId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.email;
    const res = await this.client.users.info({ user: slackUserId });
    const email = res.user?.profile?.email ?? null;
    this.emails.set(slackUserId, { email, at: Date.now() });
    return email;
  }
  async openView(triggerId: string, view: Record<string, unknown>): Promise<void> {
    await this.client.views.open({ trigger_id: triggerId, view: view as never });
  }
  async team(): Promise<{ id: string; name: string } | null> {
    const res = await this.client.auth.test();
    return res.team_id ? { id: res.team_id, name: res.team ?? res.team_id } : null;
  }
}

let override: SlackApi | null | undefined;
let fromEnv: SlackApi | null | undefined;
/** The bot (SLACK_BOT_TOKEN), or null when Slack is not connected. */
export function slackApi(): SlackApi | null {
  if (override !== undefined) return override;
  fromEnv ??= process.env["SLACK_BOT_TOKEN"] ? new WebApiSlackApi(process.env["SLACK_BOT_TOKEN"]) : null;
  return fromEnv;
}
/** Tests: a fake Slack (undefined puts the real one back). */
export function setSlackApi(api: SlackApi | null | undefined): void {
  override = api;
}
