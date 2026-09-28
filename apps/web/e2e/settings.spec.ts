import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * Product feedback 2026-09-28: the sidebar keeps Registry, Pacing rules, Roles and Tags; the other
 * admin pages live under Settings, with a strip to move between them; Settings › Workspace renames it.
 */
test("Settings holds the other admin pages; an admin renames the workspace", async ({ page }) => {
  await as(page, "admin");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/home`);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const kept of ["Registry", "Pacing rules", "Roles", "Tags", "Settings"]) await expect(nav.getByRole("link", { name: kept, exact: true })).toBeVisible();
  for (const moved of ["Approval policies", "Slack", "Data sources", "Naming templates", "Fiscal calendar", "Workspace templates", "Tours"]) await expect(nav.getByRole("link", { name: moved, exact: true })).toHaveCount(0);

  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("page-title")).toHaveText("Settings");
  await expect(page.getByTestId("settings-card")).toHaveCount(8);
  await page.getByTestId("settings-card").filter({ hasText: "Data sources" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Data sources");
  await expect(page.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("settings-strip").getByRole("link", { name: "Workspace", exact: true }).click();

  await expect(page.getByTestId("workspace-details")).toContainText("USD");
  await page.getByTestId("workspace-name-input").fill("Golden E2E");
  await page.getByTestId("workspace-save").click();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-switcher")).toContainText("Golden E2E");
  await page.getByTestId("workspace-name-input").fill("Golden");
  await page.getByTestId("workspace-save").click();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
});
