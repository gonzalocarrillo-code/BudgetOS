import { expect, test, type Page } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * HO-006 (docs/HOME_OVERVIEW_PLAN.md §3.1): Home is each person's desk. The pulse first, then what
 * waits on them, their budgets, where they left off and what they sent. Each item opens its screen
 * filtered, and every action is reachable by keyboard.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const open = async (page: Page, persona: string) => {
  await as(page, persona);
  await page.goto(`/w/${state().workspaceId}/home`);
  await expect(page.getByTestId("home-desk")).toBeVisible();
};

test("home: the pulse, then what waits, then budgets, recents and what was sent", async ({ page }) => {
  await open(page, "budgetOwner");
  const order = await page.locator("[data-tour='home-pulse'], [data-tour='home-waiting'], [data-tour='home-pacing'], [data-tour='home-recents'], [data-tour='home-sent']").evaluateAll((els) => els.map((e) => e.getAttribute("data-tour")));
  expect(order).toEqual(["home-pulse", "home-waiting", "home-pacing", "home-recents", "home-sent"]);
  // The pulse is the Overview's headline in one line, and a way there.
  await expect(page.getByTestId("home-pulse")).toContainText("budget");
  await expect(page.getByTestId("home-pulse-alerts")).toContainText(/\d+ open alerts/);
  await expect(page.getByTestId("home-as-of")).toContainText("Actuals through Aug 31, 2026");
  await page.getByTestId("home-pulse-open").click();
  await expect(page).toHaveURL(new RegExp(`/w/${state().workspaceId}$`));
  await page.screenshot({ path: test.info().outputPath("home-budget-owner-1440.png"), fullPage: true });
});

test("home: the budget owner decides, and opens the alerts on their budgets by rule", async ({ page }) => {
  await open(page, "budgetOwner");
  const bulk = page.getByTestId("home-approval").filter({ hasText: "Q4 retail push" });
  await expect(bulk).toContainText("24 budgets");
  await expect(bulk).toContainText("+5.0%");
  await expect(bulk).toContainText("Requested by Golden planner");
  const group = page.getByTestId("home-alert-group").first();
  await expect(group).toContainText(/open alerts on (EMEA|LATAM)/);
  await group.getByTestId("home-alert-rule").first().click();
  await expect(page).toHaveURL(/\/alerts\?.*rule=.*under=|\/alerts\?.*under=.*rule=/);
  await expect(page.getByTestId("alerts-only-rule")).toBeVisible();
  await expect(page.getByTestId("alerts-only-under")).toContainText(/Under (EMEA|LATAM)/);
  await expect(page.getByTestId("alerts-table").locator("tbody tr").first()).toBeVisible();
  await page.getByTestId("alerts-only-clear").click();
  await expect(page.getByTestId("alerts-only")).toHaveCount(0);
});

test("home: the planner sees what they sent waiting on others, and no data to map", async ({ page }) => {
  await open(page, "planner");
  await expect(page.getByTestId("home-sent-item").filter({ hasText: "Q4 retail push" })).toContainText("waiting on Budget owner");
  await expect(page.getByTestId("home-unmatched")).toHaveCount(0);
  await expect(page.getByTestId("home-recent").first()).toBeVisible();
  // A strip opens its budget in Budgets.
  await page.getByTestId("home-scope").first().click();
  await expect(page).toHaveURL(/\/budgets\?.*select=/);
});

test("home: an admin maps the unmatched spend from Home; every action takes the keyboard", async ({ page }) => {
  await open(page, "admin");
  const actions = page.getByTestId("home-waiting").locator("a, button");
  const n = await actions.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    await actions.nth(i).focus();
    await expect(actions.nth(i)).toBeFocused();
  }
  await page.getByTestId("home-unmatched").getByRole("link").click();
  await expect(page).toHaveURL(/\/sources/);
});

test("home on a phone: one column, nothing wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "budgetOwner");
  const overflow = await page.getByTestId("main-scroll").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("home-approval").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("home-budget-owner-375.png"), fullPage: true });
});
