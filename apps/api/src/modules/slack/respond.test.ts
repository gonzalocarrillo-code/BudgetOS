import { describe, expect, it } from "vitest";
import { slackResponder } from "./respond.js";

/** S-006: the API answers only Slack's own response_url, never an address a payload could name. */
describe("the response_url client", () => {
  it("refuses anything but a hooks.slack.com address", async () => {
    await expect(slackResponder().respond("https://evil.example/hooks", { text: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(slackResponder().respond("http://hooks.slack.com/actions/T1/2/abc", { text: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
