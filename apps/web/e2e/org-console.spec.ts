import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * ADR-052 (product feedback round 6): superadmins create and delete workspaces in the org console;
 * workspace admins never see it or any workspace but their own.
 */
test.use({ viewport: { width: 1440, height: 900 } });
const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};

test("org console: a superadmin creates a workspace with its first admin, archives, restores and deletes it", async ({ page }) => {
  await signIn(page, "orgAdmin");
  await page.goto(`/w/${state().workspaceId}/home`);
  await page.getByTestId("nav-org-console").click();
  await expect(page).toHaveURL(/\/org\/workspaces$/);
  await expect(page.getByTestId("org-workspace").first()).toBeVisible();

  const name = `E2E Console ${Date.now()}`;
  await page.getByTestId("org-new-workspace").click();
  await page.getByTestId("org-create-name").fill(name);
  await page.getByTestId("org-create-admin-email").fill(`lead.${Date.now()}@example.test`);
  await page.getByTestId("org-create-admin-name").fill("Client Lead");
  await page.getByTestId("org-create-submit").click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/home$/, { timeout: 60_000 });
  await expect(page.getByTestId("page-title")).toBeVisible();
  const created = /\/w\/([0-9a-f-]{36})\//.exec(page.url())?.[1] ?? "";

  // Back in the console: the new workspace lists its admin; archive it.
  await page.goto("/org/workspaces");
  const row = page.getByTestId("org-workspace").and(page.locator(`[data-name="${name}"]`));
  await expect(row).toContainText("Client Lead");
  await row.getByTestId("org-archive").click();
  const archived = page.getByTestId("org-workspace").and(page.locator(`[data-name="${name}"]`));
  await expect(archived.getByTestId("org-restore")).toBeVisible();

  // Opened while archived: read-only, with a banner.
  await page.goto(`/w/${created}/home`);
  await expect(page.getByTestId("archived-banner")).toBeVisible();

  // Restore, archive again, then delete by typing its name.
  await page.goto("/org/workspaces");
  await archived.getByTestId("org-restore").click();
  await expect(row.getByTestId("org-archive")).toBeVisible();
  await row.getByTestId("org-archive").click();
  await archived.getByTestId("org-delete").click();
  const dialog = page.getByTestId("org-delete-dialog");
  await dialog.getByTestId("org-delete-name").fill(name.toLowerCase());
  await expect(dialog.getByTestId("org-delete-confirm")).toHaveCount(0); // the name must match exactly
  await dialog.getByTestId("org-delete-name").fill(name);
  await dialog.getByTestId("org-delete-reason").fill("End-to-end test");
  await dialog.getByTestId("org-delete-confirm").click();
  await expect(page.getByTestId("org-workspace").and(page.locator(`[data-name="${name}"]`))).toHaveCount(0);
  await expect(page.getByTestId("toast").first()).toContainText("deleted");
});

test("org console: a workspace admin cannot open it, and has no way to it", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/home`);
  await expect(page.getByTestId("page-title")).toBeVisible();
  await expect(page.getByTestId("nav-org-console")).toHaveCount(0);
  await page.getByTestId("workspace-switcher").click();
  await expect(page.getByTestId("workspace-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-manage")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/org/workspaces");
  await expect(page.getByTestId("no-access")).toBeVisible();
});

test("org console: People lists everyone with their workspaces", async ({ page }) => {
  await signIn(page, "orgAdmin");
  await page.goto("/org/people");
  const planner = page.getByTestId("org-person").and(page.locator(`[data-email^="planner@"]`));
  await expect(planner.first()).toContainText("Golden");
  await expect(planner.first()).toContainText("Planner");
});
