import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * T-032 done-when (rule editor): a workspace admin creates a rule scoped with the Explorer's filter
 * bar (region LATAM), it is listed with its condition, and it can be switched off. A planner sees
 * the rules but is told why they cannot change them.
 */
test.describe.configure({ mode: "serial" });
test.describe("pacing rules (T-032)", () => {
  test("create a scoped rule, see its condition, switch it off", async ({ page }) => {
    await as(page, "admin");
    await page.goto(`/w/${state().workspaceId}/admin/rules`);
    await expect(page.getByTestId("rule-row").first()).toBeVisible(); // the default rules
    await page.getByTestId("rule-new").click();
    await page.getByTestId("rule-name").fill("LATAM projected overrun");
    await page.getByTestId("rule-metric").selectOption("projected_close_pct");
    await page.getByTestId("rule-comparator").selectOption("gt");
    await page.getByTestId("rule-threshold").fill("1.2");
    await page.getByTestId("rule-days").fill("2");
    await page.getByTestId("rule-severity-critical").click();
    const editor = page.getByTestId("rule-editor");
    await editor.getByTestId("filter-add").click();
    await editor.getByTestId("filter-dimension").selectOption("region");
    await editor.getByTestId("filter-values").selectOption("LATAM");
    await editor.getByTestId("filter-apply").click();
    await expect(editor.getByTestId("filter-chip")).toHaveCount(1);
    await expect(page.getByTestId("rule-summary")).toContainText("Critical alert when Projected close % of budget > 1.2 · for 2 days");
    await page.getByTestId("rule-save").click();
    const row = page.getByTestId("rule-row").filter({ hasText: "LATAM projected overrun" });
    await expect(row).toContainText("Projected close % of budget > 1.2 · for 2 days");
    await expect(row).toContainText("Critical");

    await row.click();
    await expect(page.getByTestId("rule-editor").getByTestId("filter-chip")).toHaveCount(1); // the scope came back
    await page.getByTestId("rule-active").uncheck();
    await page.getByTestId("rule-save").click();
    await expect(page.getByTestId("rule-row").filter({ hasText: "LATAM projected overrun" })).toContainText("Off");
  });

  test("a planner is told why not", async ({ page }) => {
    await as(page, "planner");
    await page.goto(`/w/${state().workspaceId}/admin/rules`);
    await expect(page.getByTestId("rule-new")).toBeDisabled();
  });
});

/** Product feedback 2026-09-28: every part of a rule is editable — period, delivery, who it's for, duplicate, delete. */
test("rules: duplicate a rule, change every part, then delete it", async ({ page }) => {
  await as(page, "admin");
  await page.goto(`/w/${state().workspaceId}/admin/rules`);
  await page.getByTestId("rule-row").first().click();
  await page.getByTestId("rule-duplicate").click();
  const editor = page.getByTestId("rule-editor");
  await expect(editor.getByTestId("rule-name")).toHaveValue(/\(copy\)$/);
  await editor.getByTestId("rule-name").fill("E2E every part");
  await editor.getByTestId("rule-metric").selectOption("spend_to_date_pct");
  await editor.getByTestId("rule-comparator").selectOption("gte");
  await editor.getByTestId("rule-threshold").fill("0.9");
  await editor.getByTestId("rule-days").fill("2");
  await editor.getByTestId("rule-period").selectOption("current_quarter");
  await editor.getByTestId("rule-severity-info").click();
  await editor.getByTestId("rule-inapp").uncheck();
  await editor.getByTestId("rule-slack").fill("#e2e-alerts");
  await editor.getByTestId("rule-assign").selectOption({ index: 1 });
  await editor.getByTestId("rule-active").uncheck();
  await editor.getByTestId("rule-save").click();

  const row = page.getByTestId("rule-row").filter({ hasText: "E2E every part" });
  await expect(row).toContainText("Off");
  await row.click();
  await expect(editor.getByTestId("rule-period")).toHaveValue("current_quarter");
  await expect(editor.getByTestId("rule-inapp")).not.toBeChecked();
  await expect(editor.getByTestId("rule-slack")).toHaveValue("#e2e-alerts");
  await expect(editor.getByTestId("rule-assign")).not.toHaveValue("");
  await expect(editor.getByTestId("rule-threshold")).toHaveValue("0.9");

  await editor.getByTestId("rule-delete").click();
  await page.getByTestId("rule-delete-yes").click();
  await expect(page.getByTestId("rule-row").filter({ hasText: "E2E every part" })).toHaveCount(0);
});
