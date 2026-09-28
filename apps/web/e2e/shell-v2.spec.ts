import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/** Phase B (DS-001…DS-005): the shell's menus, shortcuts, bell, bulk alerts, modal behaviour, phone navigation. */
test.use({ viewport: { width: 1440, height: 900 } });
const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};

test("shell: ? opens the shortcuts, g b goes to Budgets, the bell lists notifications", async ({ page }) => {
  await signIn(page, "budgetOwner");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/home`);
  await expect(page.getByTestId("page-title")).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts-dialog")).toHaveCount(0);
  await page.keyboard.press("g");
  await page.keyboard.press("b");
  await expect(page).toHaveURL(new RegExp(`/w/${ws}/budgets`));
  await page.getByTestId("notifications").click();
  await expect(page.getByTestId("notifications-panel")).toBeVisible();
});

test("alerts: tick two alerts and acknowledge them together", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/alerts`);
  const rows = page.getByTestId("alert-row");
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).getByTestId("alert-select").check();
  await rows.nth(1).getByTestId("alert-select").check();
  await expect(page.getByTestId("alerts-bulk")).toContainText("2 selected");
  await page.getByTestId("alerts-bulk-ack").click();
  await expect(page.getByTestId("toast").first()).toContainText("2 alerts updated");
  await expect(page.getByTestId("alerts-bulk")).toHaveCount(0);
});

test("a modal traps focus and closes on Escape (New budget)", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/budgets`);
  await page.getByTestId("new-budget").click();
  const dialog = page.getByTestId("new-budget-dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="new-budget-dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("phone: the navigation opens from the menu button and closes after a choice", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/home`);
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("nav-open").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("sidebar").getByRole("link", { name: "Approvals" }).click();
  await expect(page).toHaveURL(/\/approvals/);
  await expect(page.getByTestId("sidebar")).toBeHidden();
});
