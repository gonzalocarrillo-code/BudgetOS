import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * T-032 done-when (Sources + mapping wizard): a workspace admin picks a CSV, the wizard maps its
 * columns by name (the registry's dimensions, date, spend, currency) and says what is missing,
 * uploads it and creates the source with its first run; the run finishes (the local ingest
 * runner) with rows read, one rejected and the spend matched; the unmatched spend can be assigned.
 */
const CSV = [
  "date,region,country,platform,objective,audience,spend,currency,notes",
  "2026-03-15,LATAM,BR,meta,awareness,prospecting,100.00,USD,ok",
  "2026-03-16,LATAM,BR,meta,awareness,prospecting,50.00,USD,ok",
  "2026-03-17,LATAM,BR,myspace,awareness,prospecting,10.00,USD,unknown platform",
].join("\n");

test.describe.configure({ mode: "serial" });
test("mapping wizard → source → a finished run with coverage; unmatched spend is assigned", async ({ page }) => {
  test.setTimeout(120_000);
  await as(page, "admin");
  await page.goto(`/w/${state().workspaceId}/admin/sources`);
  await expect(page.getByTestId("admin-source-row").first()).toContainText("Golden actuals (CSV)");
  await page.getByTestId("source-new").click();
  await page.getByTestId("wizard-file").setInputFiles({ name: "march-spend.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(page.getByTestId("mapping-wizard")).toHaveAttribute("data-step", "2");
  const col = (name: string) => page.getByTestId("wizard-column").and(page.locator(`[data-column="${name}"]`)).getByTestId("wizard-choice");
  await expect(col("country")).toHaveValue("dim:country");
  await expect(col("date")).toHaveValue("role:period_date");
  await expect(col("spend")).toHaveValue("role:amount");
  await expect(col("notes")).toHaveValue("role:ignore");
  await expect(page.getByTestId("wizard-ok")).toBeVisible();
  // Without the currency column the mapping is incomplete, and Next says why.
  await col("currency").selectOption("role:ignore");
  await expect(page.getByTestId("wizard-problems")).toContainText("The amount needs a currency");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await col("currency").selectOption("role:currency");
  // AI suggestions are not configured locally: the wizard says so and keeps the name matching.
  await page.getByTestId("wizard-ai").click();
  await expect(page.getByTestId("wizard-ai-note")).toContainText("not set up here");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-name")).toHaveValue("march-spend");
  await page.getByTestId("wizard-create").click();

  await expect(page).toHaveURL(/\/sources\?source=/);
  const run = page.getByTestId("run-row").first();
  await expect(run.getByTestId("run-status")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
  await expect(run).toContainText("3"); // read
  await expect(run.getByTestId("run-rejected")).toHaveText("1");
  await expect(run.getByTestId("run-coverage")).toHaveText("100.0%");

  const unmatched = page.getByTestId("unmatched-row").filter({ hasText: "AMER" }).first();
  await expect(unmatched).toBeVisible();
  await unmatched.getByTestId("unmatched-assign").click();
  await page.getByTestId("assign-search").fill("LATAM BR meta awareness");
  await page.getByTestId("assign-option").first().click();
  await expect(page.getByTestId("unmatched-row").filter({ hasText: "AMER" })).toHaveCount(0);
});
