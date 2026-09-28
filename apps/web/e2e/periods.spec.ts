import { expect, test } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * Product feedback 7 (ADR-041): what a quarter is, custom partitions, and closing or reopening a
 * quarter are the workspace's own. An admin creates a 4-4-5 year and a custom period; the Explorer
 * offers them; a quarter is closed and reopened from the calendar.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("a 4-4-5 year, a custom period in the Explorer; a period closes once ended, and reopens", async ({ page }) => {
  const ws = state().workspaceId;
  const token = await tokenFor("admin");
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  await page.goto(`/w/${ws}/admin/periods`);

  await page.getByTestId("periods-year").fill("2027");
  await page.getByTestId("periods-pattern").selectOption("445");
  await page.getByTestId("periods-generate").click();
  await expect(page.getByTestId("periods-notice")).toContainText("17 periods created");
  const year = page.getByTestId("period-year").and(page.locator('[data-key="FY2027"]'));
  await expect(year).toBeVisible();
  await expect(year.getByTestId("period").and(page.locator('[data-key="2027-Q1"]'))).toContainText("2027-01-01 – 2027-04-01");

  await page.getByTestId("custom-key").fill("Black Friday 2026");
  await page.getByTestId("custom-start").fill("2026-11-20");
  await page.getByTestId("custom-end").fill("2026-11-30");
  await page.getByTestId("custom-add").click();
  await expect(page.getByTestId("period").and(page.locator('[data-key="Black Friday 2026"]'))).toBeVisible();

  // A period that has not ended cannot be closed yet; a past one closes and reopens.
  const q1 = page.getByTestId("period").and(page.locator('[data-key="2027-Q1"]'));
  await expect(q1.getByTestId("period-close")).toHaveCount(0);
  await expect(q1.locator("[data-disabled-reason]")).toHaveAttribute("data-disabled-reason", /ended/);
  await page.getByTestId("custom-key").fill("Spring sale 2025");
  await page.getByTestId("custom-start").fill("2025-03-01");
  await page.getByTestId("custom-end").fill("2025-03-31");
  await page.getByTestId("custom-add").click();
  const spring = page.getByTestId("period").and(page.locator('[data-key="Spring sale 2025"]'));
  await spring.getByTestId("period-close").click();
  await expect(spring).toHaveAttribute("data-closure", "closed");
  page.once("dialog", (d) => void d.accept("Late invoices from the agency"));
  await spring.getByTestId("period-reopen").click();
  await expect(spring).toHaveAttribute("data-closure", "restated");

  // The Explorer offers the workspace's periods; picking one puts it in the URL.
  await page.goto(`/w/${ws}/budgets`);
  const picker = page.getByTestId("period-picker");
  await expect(picker.locator('option[value="fiscal:Black Friday 2026"]')).toBeAttached();
  await picker.selectOption("fiscal:Black Friday 2026");
  await expect(page).toHaveURL(/period=.*Black(%20|\+)Friday/);
});
