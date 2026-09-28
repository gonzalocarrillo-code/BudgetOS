import { expect, test } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";
import { as } from "./ops.js";

/**
 * Product feedback 2026-09-28: Budgets opens on the fiscal year (pace reads against the budget's
 * share of the period), statuses read as words, a budget is renamed from its drawer, and "New
 * budget" adds a top-level one. Its granularities change from the drawer.
 */
test("Budgets: the fiscal year by default, readable statuses, rename from the drawer", async ({ page }) => {
  await as(page, "planner");
  await page.goto(`/w/${state().workspaceId}/budgets`);
  await expect(page.getByTestId("period-picker")).toHaveValue("current_year");
  await expect(page.getByTestId("new-budget")).toBeVisible();

  // A leaf budget's drawer: its status in words, and a rename that sticks.
  const token = await tokenFor("planner");
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${state().workspaceId}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: state().workspaceId, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: [{ field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true }] }, measures: ["budget"], limit: 1 }),
  });
  const leaf = ((await res.json()) as { rows: Array<{ envelopeId: string }> }).rows[0]?.envelopeId ?? "";
  await page.goto(`/w/${state().workspaceId}/budgets?select=${leaf}`);
  const drawer = page.getByTestId("envelope-drawer");
  await expect(drawer.getByTestId("drawer-status")).toHaveText(/^(Approved|Draft|Waiting for approval|Locked \(period closed\)|Archived)$/);
  await drawer.getByTestId("drawer-rename").click();
  const name = `Renamed ${Date.now()}`;
  await drawer.getByTestId("drawer-rename-input").fill(name);
  await drawer.getByTestId("drawer-rename-save").click();
  await expect(drawer.getByTestId("drawer-name")).toHaveText(name);
  await expect(drawer).toContainText("Renamed by hand");

  // Its granularities change from the drawer too: clear one, save, and it is gone.
  const before = await drawer.getByTestId("drawer-dimension").count();
  expect(before).toBeGreaterThan(0);
  await drawer.getByTestId("drawer-edit-dimensions").click();
  const set = drawer.getByTestId("drawer-dimension-select").filter({ has: page.locator("option:checked:not([value=''])") });
  await set.last().selectOption("");
  await drawer.getByTestId("drawer-dimensions-save").click();
  await expect(drawer.getByTestId("drawer-dimension")).toHaveCount(before - 1);
});
