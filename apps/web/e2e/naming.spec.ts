import { expect, test } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";
import { as } from "./ops.js";

/**
 * T-036 (spec §24.4): the naming template builder. The golden match key template is there (codes,
 * lower case); a display template built from chips previews five budgets and, saved, renames them
 * — the budget drawer shows the display name with the original under it. Afterwards the display
 * template is switched off again so later specs see the golden names.
 */
test.describe.configure({ mode: "serial" });
test("naming: build a display template from chips, preview five, save; the match key template is the golden one", async ({ page }) => {
  await as(page, "admin");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/admin/naming?kind=%22match_key%22`);
  const builder = page.getByTestId("naming-builder");
  await expect(builder).toHaveAttribute("data-kind", "match_key");
  await expect(builder.getByTestId("naming-chip")).toHaveCount(7); // country _ platform _ objective _ audience
  await expect(builder.getByTestId("naming-preview-rendered").first()).toHaveText(/^[a-z]{2}_[a-z_]+$/);

  await page.getByTestId("naming-tab-display").click();
  await expect(page.getByTestId("naming-builder")).toHaveAttribute("data-kind", "display");
  await expect(page.getByTestId("naming-save")).toBeDisabled(); // no chip yet
  await page.getByTestId("naming-add-dimension").and(page.locator('[data-key="country"]')).click();
  for (const sep of [" ", "·", " "]) await page.getByTestId("naming-add-separator").and(page.locator(`[data-value="${sep}"]`)).click();
  await page.getByTestId("naming-add-dimension").and(page.locator('[data-key="platform"]')).click();
  await page.getByTestId("naming-add-separator").and(page.locator('[data-value=" "]')).click();
  await page.getByTestId("naming-add-period").and(page.locator('[data-format="yyyy-QQ"]')).click();
  await expect(page.getByTestId("naming-chip")).toHaveCount(7);
  const rendered = page.getByTestId("naming-preview-rendered");
  await expect(rendered).toHaveCount(5); // done-when: five samples
  await expect(rendered.first()).toHaveText(/^[A-Z][a-z].* · .+ 2026-Q[1-4]$/); // labels, not codes
  // Reorder: move the period to the front, then back.
  await page.getByRole("button", { name: "Move yyyy-QQ left" }).click();
  await expect(page.getByTestId("naming-chip").nth(5)).toContainText("yyyy-QQ");
  await page.getByRole("button", { name: "Move yyyy-QQ right" }).click();
  await page.getByTestId("naming-save").click();
  await expect(page.getByTestId("naming-notice")).toContainText("budgets renamed");

  const token = await tokenFor("admin");
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-workspace-id": ws, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json() as Promise<unknown>);
  const templates = (await api("GET", `/workspaces/${ws}/naming-templates`)) as Array<{ id: string; kind: string; isActive: boolean }>;
  const displayTemplate = templates.find((x) => x.kind === "display" && x.isActive);
  expect(displayTemplate).toBeDefined();
  try {
    await page.goto(`/w/${ws}/approvals/${state().approvalRequestId}`);
    await page.getByTestId("diff-row").first().getByRole("link").click();
    await expect(page.getByTestId("drawer-name")).toHaveText(/ · .+ 2026-Q[1-4]$/);
    await expect(page.getByTestId("drawer-original-name")).not.toBeEmpty();
  } finally {
    await api("PATCH", `/naming-templates/${displayTemplate?.id ?? ""}`, { isActive: false });
  }
});
