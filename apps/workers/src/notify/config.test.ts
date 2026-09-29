import { describe, expect, it } from "vitest";
import { slackConfigWarnings } from "./slack.js";

/** S-001: a bot token without the web app's URL posts links nobody can open; say so at start. */
describe("Slack configuration warnings", () => {
  it("warns when the token is set without APP_BASE_URL, and only then", () => {
    expect(slackConfigWarnings({ SLACK_BOT_TOKEN: "xoxb-1" })).toEqual([expect.stringContaining("APP_BASE_URL")]);
    expect(slackConfigWarnings({ SLACK_BOT_TOKEN: "xoxb-1", APP_BASE_URL: "https://budget.example.org" })).toEqual([]);
    expect(slackConfigWarnings({})).toEqual([]);
  });
});
