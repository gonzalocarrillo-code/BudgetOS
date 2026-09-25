import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * T-028 done-when (spec §22): qualifier autocomplete in the global search. Keys and values come
 * from /search/suggest (registry dimensions included, custom ones too); a completed qualifier is a
 * chip and narrows the results; a hit opens its deep link; "See all" and ⇧Enter lead on.
 */

const signIn = async (page: Page) => {
  const token = await tokenFor("planner");
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};
const input = (page: Page) => page.getByTestId("search-input");
const suggestion = (page: Page, text: string) => page.getByTestId("search-suggestion").filter({ hasText: text }).first();

test.describe("global search (T-028)", () => {
  test("qualifier autocomplete: key, then value, then a chip that narrows the results; a hit opens its envelope", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${state().workspaceId}`);
    await expect(page.getByTestId("user-email")).toBeVisible(); // the shell (and its shortcuts) is up
    await page.keyboard.press("ControlOrMeta+k");
    await expect(input(page)).toBeFocused();
    await input(page).fill("reg");
    await suggestion(page, "region:").click();
    await expect(input(page)).toHaveValue("region:");
    await expect(suggestion(page, "LATAM")).toBeVisible();
    await suggestion(page, "LATAM").click();
    await expect(input(page)).toHaveValue("region:LATAM ");
    await expect(page.getByTestId("search-chip")).toHaveText(["region: LATAM"]);

    const envelopes = page.getByTestId("search-group-envelope");
    await expect(envelopes).toBeVisible();
    await expect(envelopes.getByTestId("search-hit").first()).toBeVisible();
    const heading = (await envelopes.locator("[cmdk-group-heading]").textContent()) ?? "";
    expect(Number(heading.split("·")[1]?.trim())).toBeGreaterThan(0);
    const title = (await envelopes.getByTestId("search-hit").first().locator("span.font-medium").textContent()) ?? "";
    await envelopes.getByTestId("search-hit").first().click();
    await expect(page).toHaveURL(/\/budgets\?.*select=/);
    await expect(page.getByTestId("drawer-name")).toHaveText(title);
  });

  test("a custom registry dimension is a qualifier with its values", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${state().workspaceId}`);
    await expect(page.getByTestId("user-email")).toBeVisible(); // the shell (and its shortcuts) is up
    await page.getByTestId("global-search").click();
    await input(page).fill("walmart ret");
    await suggestion(page, "retailer:").click();
    await expect(suggestion(page, "walmart")).toBeVisible();
    await suggestion(page, "walmart").click();
    await expect(input(page)).toHaveValue("walmart retailer:walmart ");
    await expect(page.getByTestId("search-group-envelope").getByTestId("search-hit")).toHaveCount(1);
    await expect(page.getByTestId("search-group-envelope").getByTestId("search-hit")).toContainText("Walmart");
  });

  test("See all opens the results page for that type; ⇧Enter opens the Explorer filtered", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${state().workspaceId}`);
    await expect(page.getByTestId("user-email")).toBeVisible(); // the shell (and its shortcuts) is up
    await page.keyboard.press("/");
    await input(page).fill("region:EMEA");
    await expect(page.getByTestId("search-see-all").first()).toBeVisible();
    await page.getByTestId("search-see-all").first().click();
    await expect(page).toHaveURL(/\/search\?.*type=/);
    await expect(page.getByTestId("result-hit").first()).toBeVisible();
    await expect(page.getByTestId("search-query")).toContainText("region:EMEA");

    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("region:EMEA");
    await expect(page.getByTestId("search-explorer")).toBeVisible();
    await page.keyboard.press("Shift+Enter");
    await expect(page).toHaveURL(/\/budgets\?.*filter=/);
    await expect(page.getByTestId("filter-chip")).toHaveCount(1);
    await expect(page.getByTestId("filter-chip")).toContainText("Region");
  });
});
