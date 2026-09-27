import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * T-041 done-when (spec §22): typing a setting name in ⌘K opens the right admin page — with its
 * tab selected when the setting lives on one — for any role, since the admin pages are.
 */

const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};
const input = (page: Page) => page.getByTestId("search-input");

async function openSetting(page: Page, q: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input(page)).toBeFocused();
  await input(page).fill(q);
  await expect(page.getByTestId("search-group-setting")).toBeVisible();
  await expect(page.locator("[cmdk-item][data-selected=true]")).toContainText(new RegExp(q, "i"));
  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveCount(0);
}

test.describe("settings search (T-041)", () => {
  test("typing a setting name in ⌘K and pressing Enter opens its admin page", async ({ page }) => {
    await signIn(page, "admin");
    const ws = state().workspaceId;
    await page.goto(`/w/${ws}`);
    await expect(page.getByTestId("user-email")).toBeVisible(); // the shell (and its shortcuts) is up

    await openSetting(page, "pacing rules");
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/admin/rules$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pacing rules");

    await openSetting(page, "metric library");
    await expect(page).toHaveURL(/\/admin\/registry\?tab=/);
    await expect(page.getByTestId("registry-tab-metrics")).toHaveAttribute("aria-selected", "true");

    await openSetting(page, "match keys");
    await expect(page).toHaveURL(/\/admin\/naming\?kind=/);
    await expect(page.getByTestId("naming-tab-match_key")).toHaveAttribute("aria-selected", "true");
  });

  test("a keyword finds the setting too, for a planner", async ({ page }) => {
    await signIn(page, "planner");
    await page.goto(`/w/${state().workspaceId}`);
    await expect(page.getByTestId("user-email")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("snowflake");
    const settings = page.getByTestId("search-group-setting");
    await expect(settings.getByTestId("search-hit").first()).toContainText("Data sources");
    await settings.getByTestId("search-hit").first().click();
    await expect(page).toHaveURL(/\/admin\/sources$/);
  });
});
