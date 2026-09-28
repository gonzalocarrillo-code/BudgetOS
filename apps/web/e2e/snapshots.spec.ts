import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * H-006 / H-007 done-when (docs/BUDGET_HISTORY_PLAN.md §2.7): finance saves a plan snapshot by
 * hand from Budgets; after a budget changes, Budgets compares with it (Snapshot · Now · Change),
 * the drawer says what the snapshot held, Overview shows "Since the plan", Closures saves a close,
 * and Settings › Fiscal calendar renames and archives snapshots.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": state().workspaceId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as Record<string, unknown>;
};
const idOf = async (token: string, name: string) => {
  const res = await call(token, "GET", `/workspaces/${state().workspaceId}/search?q=${encodeURIComponent(name)}&types=envelope&limit=20`);
  const hit = ((res["groups"] as Array<{ type: string; hits: Array<{ id: string; title: string }> }>).find((g) => g.type === "envelope")?.hits ?? []).find((h) => h.title === name);
  if (!hit) throw new Error(`no envelope named ${name}`);
  return hit.id;
};
const ws = () => state().workspaceId;

test.describe.configure({ mode: "serial" });
test.describe("snapshots (H-006, H-007)", () => {
  const plan = "Q4 plan (e2e)";
  const leafName = "DE meta conversion retargeting";

  test("save a plan snapshot from Budgets, change a budget, then compare with it", async ({ page }) => {
    await as(page, "finance1");
    await page.goto(`/w/${ws()}/budgets`);
    await page.getByTestId("save-snapshot").click();
    const dialog = page.getByTestId("snapshot-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("snapshot-save")).toBeDisabled(); // needs a name
    await page.getByTestId("snapshot-name").fill(plan);
    await page.getByTestId("snapshot-kind").selectOption("plan");
    await page.getByTestId("snapshot-scope-workspace").check();
    await page.getByTestId("snapshot-period").fill("2026-Q4");
    await page.getByTestId("snapshot-save").click();
    await expect(page.getByTestId("notice-ok")).toContainText(`Saved snapshot ${plan}`);

    // A budget moves after the snapshot: 100 less (an admin's change applies at once).
    const admin = await tokenFor("admin");
    const leaf = await idOf(admin, leafName);
    const env = await call(admin, "GET", `/envelopes/${leaf}`);
    const current = env["current"] as { amount: string };
    const draft = await call(admin, "PATCH", `/envelopes/${leaf}/draft`, { amount: (Number(current.amount) - 100).toFixed(2), basedOnVersionId: env["currentVersionId"] });
    await call(admin, "POST", `/envelopes/${leaf}/submit`, { versionId: draft["id"] ?? draft["versionId"] });

    const listed = (await call(admin, "GET", `/workspaces/${ws()}/baselines`))["baselines"] as Array<{ id: string; name: string }>;
    await page.getByTestId("compare-picker").selectOption(listed.find((b) => b.name === plan)?.id as string);
    await expect(page.getByTestId("compare-banner")).toContainText(`Comparing with ${plan}`);
    await expect(page).toHaveURL(/compareTo=/);
    const grid = page.getByTestId("explorer-grid");
    await expect(grid).toHaveAttribute("data-change-total", /^-?\d/);

    // The drawer says what the snapshot held for the budget, and lists it under History.
    await page.goto(`${page.url()}&select=%22${leaf}%22`);
    await expect(page.getByTestId("drawer-compare")).toContainText(`In ${plan}:`);
    await page.getByTestId("drawer-tab-history").click();
    await expect(page.getByTestId("drawer-snapshot").filter({ hasText: plan })).toBeVisible();

    await page.getByTestId("envelope-drawer").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId("compare-stop").click();
    await expect(page.getByTestId("compare-banner")).toHaveCount(0);
  });

  test("Overview shows the change since the plan, and opens Budgets comparing with it", async ({ page }) => {
    await as(page, "finance1");
    await page.goto(`/w/${ws()}/`);
    const tile = page.getByTestId("tile-since-plan");
    await expect(tile).toContainText("Since the plan");
    await expect(tile).toContainText(plan);
    await expect(page.getByTestId("since-plan-counts")).toContainText("down");
    await tile.click();
    await expect(page.getByTestId("compare-banner")).toContainText(plan);
  });

  test("Closures saves the period's close as a snapshot", async ({ page }) => {
    await as(page, "finance1");
    await page.goto(`/w/${ws()}/closures`);
    await page.getByTestId("closure-row").and(page.locator('[data-period="2026-Q1"]')).click();
    await page.getByTestId("closure-save-close").click();
    await expect(page.getByTestId("closure-snapshot").filter({ hasText: "2026-Q1 close" })).toBeVisible();
  });

  test("Settings › Fiscal calendar lists snapshots; rename and archive, never delete", async ({ page }) => {
    await as(page, "finance1");
    await page.goto(`/w/${ws()}/admin/periods`);
    const row = page.getByTestId("snapshot-row").and(page.locator(`[data-name="${plan}"]`));
    await expect(row).toBeVisible();
    await row.getByTestId("snapshot-rename").click();
    await page.getByTestId("snapshot-rename-input").fill("Q4 plan (agreed)");
    await page.getByTestId("snapshot-rename-save").click();
    const renamed = page.getByTestId("snapshot-row").and(page.locator('[data-name="Q4 plan (agreed)"]'));
    await expect(renamed).toBeVisible();
    await renamed.getByTestId("snapshot-archive").click();
    await expect(renamed).toHaveCount(0);
    await page.getByTestId("snapshots-show-archived").check();
    await expect(renamed).toContainText("Archived");
    await renamed.getByTestId("snapshot-archive").click(); // Restore
    await expect(renamed).not.toContainText("Archived");
  });
});
