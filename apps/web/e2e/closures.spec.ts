import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * T-032 done-when (Closures screen): the golden restated 2026-Q1 is listed with its frozen report;
 * Finance closes 2026-08 after confirming (its budgets lock), and a workspace admin restates it
 * with a reason (they unlock), so later specs see the budgets open.
 */
test.describe.configure({ mode: "serial" });
test("closures: frozen report, close a month with confirmation, restate it", async ({ page }) => {
  test.setTimeout(180_000);
  await as(page, "finance1");
  const url = `/w/${state().workspaceId}/closures`;
  await page.goto(url);
  const q1 = page.getByTestId("closure-row").and(page.locator('[data-period="2026-Q1"]'));
  await expect(q1).toContainText("Restated");
  await q1.click();
  await expect(page.getByTestId("closure-totals")).toContainText("Budget");
  await expect(page.getByTestId("closure-top").locator("tbody tr").first()).toBeVisible();

  await expect(page.getByTestId("close-submit")).toBeDisabled(); // no period yet
  await page.getByTestId("close-period").fill("2026-08");
  await page.getByTestId("close-submit").click();
  await expect(page.getByRole("alertdialog")).toContainText("Close 2026-08?");
  await page.getByTestId("close-confirm").click();
  const sep = page.getByTestId("closure-row").and(page.locator('[data-period="2026-08"]'));
  await expect(sep).toContainText("Closed", { timeout: 120_000 });
  await expect(page.getByTestId("closure-report")).toBeVisible();
  await expect(page.getByTestId("restate-submit")).toBeDisabled(); // Finance cannot restate

  await as(page, "admin");
  await page.goto(url);
  await sep.click();
  await page.getByTestId("restate-reason").fill("Late invoices for August");
  await page.getByTestId("restate-submit").click();
  await expect(sep).toContainText("Restated");
});
