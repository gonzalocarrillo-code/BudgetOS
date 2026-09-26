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

  await page.getByTestId("heatmap-row").and(page.locator('[data-code="BR"]')).getByTestId("heatmap-cell").first().click();
  await expect(page).toHaveURL(/\/budgets\?.*view=pivot/);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
});
