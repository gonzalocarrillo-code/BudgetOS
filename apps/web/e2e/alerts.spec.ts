import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * T-032 done-when (Alerts screen): the golden pacing run's open alerts are listed with their budget
 * and rule by name and the value against the threshold; severity narrows them; acknowledge moves
 * one to Acknowledged, and resolve moves it to Resolved.
 */
test.describe.configure({ mode: "serial" });
test("alerts: list, filter by severity, acknowledge, then resolve", async ({ page }) => {
  await as(page, "planner");
  await page.goto(`/w/${state().workspaceId}/alerts`);
  const rows = page.getByTestId("alert-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first().getByTestId("alert-budget")).not.toHaveText(/^[0-9a-f-]{36}$/); // a name, not an id
  await expect(rows.first().getByTestId("alert-value")).toContainText(/[<>≤≥]/);
  const open = await rows.count();

  await page.getByTestId("alerts-severity-critical").click();
  await expect(page).toHaveURL(/severity=/);
  await expect(page.getByTestId("severity-chip").first()).toHaveText("Critical");
  await page.getByTestId("alerts-severity-all").click();
  await expect(rows).toHaveCount(open);

  const budget = (await rows.first().getByTestId("alert-budget").textContent()) ?? "";
  await rows.first().getByTestId("alert-ack").click();
  await expect(rows).toHaveCount(open - 1);
  await page.getByTestId("alerts-tab-acknowledged").click();
  const acked = page.getByTestId("alert-row").filter({ hasText: budget }).first();
  await expect(acked).toBeVisible();
  await expect(acked.getByTestId("alert-ack")).toHaveCount(0);
  await acked.getByTestId("alert-resolve").click();
  await page.getByTestId("alerts-tab-resolved").click();
  await expect(page.getByTestId("alert-row").filter({ hasText: budget }).first()).toBeVisible();
});
