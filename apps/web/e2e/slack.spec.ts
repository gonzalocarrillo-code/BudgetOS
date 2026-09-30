import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * Slack (ADR-046, R11-003). Settings › Slack routes this workspace: channels and severities (kept
 * after a reload), and why a non-admin cannot change them. The connection (secrets, manifest,
 * linking) is Org console › Slack, superadmins only. (Buttons and /budget are covered against a
 * fake Slack in apps/api/src/modules/slack.)
 */
test("an admin sets where alerts and approvals post; a planner sees why not", async ({ page }) => {
  await as(page, "admin");
  await page.goto(`/w/${state().workspaceId}/admin/slack`);
  await expect(page.getByTestId("page-title")).toHaveText("Slack");
  // The connection is the org's: the workspace page says so and holds no setup.
  await expect(page.getByTestId("slack-status")).toContainText("isn't connected for your organization");
  await expect(page.getByText("Copy the manifest")).toHaveCount(0);
  await page.getByTestId("slack-default-channel").fill("#budget-ops");
  await page.getByTestId("slack-alert-channel").fill("#budget-alerts");
  await page.getByTestId("slack-sev-warning").check();
  await expect(page.getByTestId("slack-dms")).toBeChecked(); // S-004: on unless turned off
  await page.getByTestId("slack-dms").uncheck();
  await page.getByTestId("slack-save").click();
  await expect(page.getByTestId("slack-notice")).toHaveText("Slack settings saved.");
  await page.reload();
  await expect(page.getByTestId("slack-default-channel")).toHaveValue("#budget-ops");
  await expect(page.getByTestId("slack-alert-channel")).toHaveValue("#budget-alerts");
  await expect(page.getByTestId("slack-sev-warning")).toBeChecked();
  await expect(page.getByTestId("slack-dms")).not.toBeChecked();

  await as(page, "planner");
  await page.goto(`/w/${state().workspaceId}/admin/slack`);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("the org console holds the connection: secrets, manifest, link, and each workspace's channels", async ({ page }) => {
  await as(page, "orgAdmin");
  await page.goto("/org/slack");
  await expect(page.getByTestId("page-title")).toHaveText("Slack");
  await expect(page.getByTestId("org-slack-status")).toContainText("Bot token");
  await expect(page.getByTestId("org-slack-team")).toContainText("Not linked");
  await expect(page.getByTestId("org-slack-setup")).toContainText("manifest");
  await expect(page.getByTestId("org-slack-workspaces")).toContainText("Golden");
  // Without a bot token, Link says why.
  await expect(page.getByRole("button", { name: "Link to Slack" })).toBeDisabled();

  // A workspace admin is not a superadmin: the org console refuses them.
  await as(page, "admin");
  await page.goto("/org/slack");
  await expect(page.getByTestId("org-slack-status")).toHaveCount(0);
});
