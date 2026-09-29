import { describe, expect, it } from "vitest";
import { SLACK_BOT_SCOPES, slackManifest } from "./manifest.js";

/** S-002: the Slack app asks for exactly the scopes the bot uses, and points at the API it is made for. */
describe("the Slack app manifest", () => {
  it("asks for exactly the scopes the bot calls, and never chat:write.public", () => {
    const m = slackManifest("https://budget.example.org/") as { oauth_config: { scopes: { bot: string[] } } };
    expect(m.oauth_config.scopes.bot).toEqual(["chat:write", "commands", "im:write", "users:read", "users:read.email"]);
    expect(m.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    expect(m.oauth_config.scopes.bot).not.toContain("chat:write.public");
  });

  it("points /budget and the buttons at the API it is made for, as BudgetOS", () => {
    const m = slackManifest("https://budget.example.org/") as {
      display_information: { name: string };
      features: { bot_user: { display_name: string }; slash_commands: Array<{ command: string; url: string }>; app_home: Record<string, boolean> };
      settings: { interactivity: { request_url: string }; socket_mode_enabled: boolean };
    };
    expect(m.display_information.name).toBe("BudgetOS");
    expect(m.features.bot_user.display_name).toBe("BudgetOS");
    expect(m.features.slash_commands).toEqual([expect.objectContaining({ command: "/budget", url: "https://budget.example.org/api/v1/slack/commands" })]);
    expect(m.settings.interactivity.request_url).toBe("https://budget.example.org/api/v1/slack/interactions");
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.features.app_home).toMatchObject({ home_tab_enabled: false, messages_tab_enabled: true });
  });
});
