import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * T-033 done-when (spec §22, Epic 1.11): the Overview renders in < 1.5 s on the small golden with
 * zero configuration — pacing heatmap (market × platform), most over / under pace, KPI vs target,
 * open alerts, approvals due and data freshness. Timed from asking for the numbers to every widget
 * rendered, for a period not yet fetched (the modules are loaded first: in dev mode a first visit
 * mostly measures Vite compiling them; a production bundle has them already).
 */
test("overview: every widget, in under 1.5 s", async ({ page }) => {
  await as(page, "budgetOwner");
  await page.goto(`/w/${state().workspaceId}/alerts`);
  await expect(page.getByTestId("page-title")).toHaveText("Alerts");

  // First visit: Vite's dev server compiles and serves the route's modules (a production bundle has them already).
  const cold = Date.now();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
  test.info().annotations.push({ type: "first visit (dev modules)", description: `${Date.now() - cold} ms` });

  // The dashboard itself: a new period is a new request (never cached), then every widget renders.
  const started = Date.now();
  await page.getByTestId("overview-period").selectOption("ytd");
  await expect(page.getByTestId("overview")).toHaveAttribute("data-period", "ytd"); // rendered only with that period's data
  await expect(page.getByTestId("heatmap-cell").first()).toBeVisible();
  await expect(page.getByTestId("overview-freshness")).toBeVisible();
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "overview render", description: `${elapsed} ms` });
  expect(elapsed).toBeLessThan(1500);
  await page.getByTestId("overview-period").selectOption("current_year");
  await expect(page.getByTestId("overview")).toHaveAttribute("data-period", "current_year");

  // Heatmap: country × platform, with its legend, and a cell opens those budgets in the Explorer pivot.
  await expect(page.getByTestId("heatmap-row").and(page.locator('[data-code="BR"]'))).toContainText("Brazil");
  await expect(page.getByTestId("heatmap-legend")).toContainText("on plan");
  await expect(page.getByTestId("over-pace").getByTestId("leaf-row").first()).toBeVisible();
  await expect(page.getByTestId("kpi-row").first()).toBeVisible();
  await expect(page.getByTestId("tile-alerts")).not.toHaveText(/Open alerts\s*0/);
  await expect(page.getByTestId("overview-approvals").getByTestId("overview-approval").first()).toBeVisible(); // the golden bulk waits on the budget owner
  await expect(page.getByTestId("overview-freshness")).toContainText("Actuals through 2026-08-01");
  await expect(page.getByTestId("freshness-source").first()).toContainText("Golden actuals (CSV)");

  // Cells read as % of the budget spent; the axes are the user's pick, kept in the URL (feedback 8).
  await expect(page.getByTestId("heatmap-spent").first()).toHaveText(/^\d+%$/);
  await expect(page.getByTestId("tile-spent")).toContainText("of the period gone");
  await page.getByTestId("heatmap-cols").selectOption("objective");
  await expect(page).toHaveURL(/cols=%22objective%22|cols=objective/);
  await expect(page.getByTestId("heatmap-col").first()).toBeVisible();
  await page.getByTestId("heatmap-cols").selectOption("platform");

  // A cell opens its budgets beside the heatmap; from there, the same budgets in the Explorer pivot.
  await page.getByTestId("heatmap-row").and(page.locator('[data-code="BR"]')).getByTestId("heatmap-cell").first().click();
  await expect(page.getByTestId("cell-editor")).toBeVisible();
  await page.getByTestId("cell-editor-open-budgets").click();
  await expect(page).toHaveURL(/\/budgets\?.*view=pivot/);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
});

/** Product feedback: edit budgets from the Overview, one at a time or all of a cell by a percentage. */
test("overview: edit a cell's budgets without leaving the page", async ({ page }) => {
  await as(page, "planner");
  await page.goto(`/w/${state().workspaceId}`);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("heatmap-row").and(page.locator('[data-code="MX"]')).getByTestId("heatmap-cell").first().click();
  const editor = page.getByTestId("cell-editor");
  await expect(editor.getByTestId("cell-editor-row").first()).toBeVisible();
  await expect(editor.getByTestId("cell-editor-summary")).toContainText("spent");

  // All of the cell by a percentage: the bulk preview, nothing written until Commit.
  await editor.getByTestId("cell-change").fill("10");
  await editor.getByTestId("cell-change-preview").click();
  const dialog = page.getByTestId("paste-dialog");
  await expect(dialog).toContainText("Change by 10%");
  await expect(dialog.getByTestId("paste-row").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // One budget: a new amount becomes a draft, then Send for approval, as in Budgets.
  const row = editor.getByTestId("cell-editor-row").first();
  await row.getByTestId("cell-editor-amount").fill("12345");
  await row.getByTestId("cell-editor-save").click();
  await expect(row.getByRole("button", { name: /Send for approval/ })).toBeVisible();

  await editor.getByTestId("cell-editor-close").click();
  await expect(editor).toHaveCount(0);
});

/** Product feedback: choose what the Overview shows; the choice is saved for that person. */
test("overview: hide and show tiles and panels, kept after a reload", async ({ page }) => {
  await as(page, "finance1");
  await page.goto(`/w/${state().workspaceId}`);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("heatmap")).toBeVisible();

  await page.getByTestId("overview-customise").click();
  await page.getByTestId("customise-heatmap").uncheck();
  await page.getByTestId("customise-tile.alerts").uncheck();
  await expect(page.getByTestId("heatmap")).toHaveCount(0);
  await expect(page.getByTestId("tile-alerts")).toHaveCount(0);
  await expect(page.getByTestId("overview-customise")).toContainText("2 hidden");

  await page.reload();
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("overview-freshness")).toBeVisible();
  await expect(page.getByTestId("heatmap")).toHaveCount(0);
  await expect(page.getByTestId("tile-alerts")).toHaveCount(0);

  await page.getByTestId("overview-customise").click();
  await page.getByTestId("customise-reset").click();
  await expect(page.getByTestId("heatmap")).toBeVisible();
  await expect(page.getByTestId("tile-alerts")).toBeVisible();
});

/** The workspace's own periods (a fiscal quarter as defined in Admin › Fiscal calendar) are on the Overview too. */
test("overview: a fiscal period from the calendar", async ({ page }) => {
  await as(page, "budgetOwner");
  await page.goto(`/w/${state().workspaceId}`);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
  const fiscal = page.getByTestId("overview-period").locator('option[value^="fiscal:"]');
  test.skip((await fiscal.count()) === 0, "the golden workspace has no fiscal calendar rows");
  const value = await fiscal.first().getAttribute("value");
  await page.getByTestId("overview-period").selectOption(value as string);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-period", value as string);
  await expect(page.getByTestId("heatmap-cell").first()).toBeVisible();
});
