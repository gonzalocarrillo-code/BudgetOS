import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * Product feedback 2026-09-28, Slack: Admin › Slack shows whether the bot is connected, takes the
 * channels and severities (kept after a reload), and says why a non-admin cannot change them.
 * (Buttons and /budget are covered against a fake Slack in apps/api/src/modules/slack.)
 */
test("an admin sets where alerts and approvals post; a planner sees why not", async ({ page }) => {
  await as(page, "admin");
  await page.goto(`/w/${state().workspaceId}/admin/slack`);
  await expect(page.getByTestId("page-title")).toHaveText("Slack");
  await expect(page.getByTestId("slack-status")).toContainText("Bot token");
  await expect(page.getByTestId("slack-setup")).toContainText("manifest");
  await page.getByTestId("slack-default-channel").fill("#budget-ops");
  await page.getByTestId("slack-alert-channel").fill("#budget-alerts");
  await page.getByTestId("slack-sev-warning").check();
  await page.getByTestId("slack-save").click();
  await expect(page.getByTestId("slack-notice")).toHaveText("Slack settings saved.");
  await page.reload();
  await expect(page.getByTestId("slack-default-channel")).toHaveValue("#budget-ops");
  await expect(page.getByTestId("slack-alert-channel")).toHaveValue("#budget-alerts");
  await expect(page.getByTestId("slack-sev-warning")).toBeChecked();

  await as(page, "planner");
  await page.goto(`/w/${state().workspaceId}/admin/slack`);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
