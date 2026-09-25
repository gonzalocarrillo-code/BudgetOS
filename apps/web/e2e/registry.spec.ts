import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * T-031 done-when (spec §22): the add-dimension flow. A workspace admin creates a granularity with
 * an icon from the library and nested values (`Parent > Child`), and it appears in the Explorer's
 * filters and as a ⌘K qualifier with its values in under 10 s, with no reload. Then values move
 * under another value, a hierarchy puts the new granularity in the Explorer tree, the default
 * granularities (country, objective: brand / non-brand / competitor) are there, and an org admin
 * adds a metric.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};
const registry = () => `/w/${state().workspaceId}/admin/registry`;
const row = (page: Page, code: string) => page.getByTestId("value-row").and(page.locator(`[data-code="${code}"]`));

test.describe.configure({ mode: "serial" });
test.describe("registry (T-031)", () => {
  test("add-dimension flow: icon from the library, nested values, in filters and search in < 10 s", async ({ page }) => {
    await as(page, "admin");
    await page.goto(registry());
    await page.getByTestId("dim-new").click();
    await page.getByTestId("dim-label").fill("Retail tier");
    await expect(page.getByTestId("dim-key")).toHaveValue("retail_tier");
    await page.getByTestId("icon-search").fill("store");
    await page.getByTestId("icon-option").and(page.locator('[data-icon="store"]')).click();
    await expect(page.getByTestId("icon-option").and(page.locator('[data-icon="store"]'))).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("dim-parent").and(page.locator('[data-key="country"]')).click();
    await page.getByTestId("dim-values").fill("Tier 1 > Flagship\nTier 1 > Core\nTier 2");

    const started = Date.now();
    await page.getByTestId("dim-save").click();
    await expect(page.getByTestId("dimension-header")).toContainText("Retail tier");
    await expect(page.getByTestId("dimension-header")).toContainText("nests under country");
    await expect(row(page, "flagship")).toBeVisible();
    await expect(row(page, "tier_2")).toBeVisible();

    // Filters: client-side navigation (no reload) to the Explorer.
    await page.getByRole("link", { name: "Budgets", exact: true }).click();
    await page.getByTestId("filter-add").click();
    await expect(page.getByTestId("filter-dimension").locator('option[value="retail_tier"]')).toBeAttached();
    // Search: the new key is a qualifier, with its values.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("search-input").fill("retail");
    await page.getByTestId("search-suggestion").filter({ hasText: "retail_tier:" }).first().click();
    await expect(page.getByTestId("search-suggestion").filter({ hasText: "Tier 2" }).first()).toBeVisible();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
  });

  test("values: move under another (with its children), add a child, rename, retire", async ({ page }) => {
    await as(page, "admin");
    await page.goto(registry());
    await page.getByTestId("dimension-item").and(page.locator('[data-key="retail_tier"]')).click();
    await row(page, "core").getByTestId("value-actions").click();
    await page.getByTestId("value-child-input").fill("Core North");
    await page.getByTestId("value-child-add").click();
    await expect(row(page, "core_north")).toBeVisible();
    await expect(page.getByTestId("value-panel")).toHaveCount(1); // still open on Core
    await page.getByTestId("value-move").selectOption("tier_2");
    // Tier 2 > Core > Core North: the child moved with its parent (depth shows as indentation, the order is the tree's).
    await expect(page.getByTestId("value-row").locator("[data-testid=value-label]")).toHaveText(["Tier 1", "Flagship", "Tier 2", "Core", "Core North"]);
    await row(page, "flagship").getByTestId("value-actions").click();
    await page.getByTestId("value-rename-input").fill("Flagship stores");
    await page.getByTestId("value-rename").click();
    await expect(row(page, "flagship").getByTestId("value-label")).toHaveText("Flagship stores");
    await page.getByTestId("value-retire").click();
    await expect(row(page, "flagship")).toHaveCount(0);
    await page.getByText("Show retired and merged").click();
    await expect(row(page, "flagship")).toContainText("retired");
  });

  test("hierarchy builder: a new hierarchy with the granularity, then in the Explorer's tree picker", async ({ page }) => {
    await as(page, "admin");
    await page.goto(`${registry()}?tab=%22hierarchies%22`);
    await page.getByTestId("template-new").click();
    await page.getByTestId("template-name").fill("Country by retail tier");
    await page.getByTestId("template-add").and(page.locator('[data-key="retail_tier"]')).click();
    await page.getByTestId("template-add").and(page.locator('[data-key="country"]')).click();
    // Country (nests under region) cannot sit under Retail tier: the level says why until it moves up.
    await expect(page.getByTestId("template-level").nth(1)).toContainText("cannot sit under Retail tier");
    await expect(page.getByTestId("template-save")).toBeDisabled();
    await expect(page.getByTestId("template-level").first()).toHaveAttribute("data-key", "retail_tier");
    await page.getByRole("button", { name: "Move Country up" }).click();
    await expect(page.getByTestId("template-levels").getByTestId("template-level")).toHaveText([/Country/, /Retail tier/]);
    await page.getByTestId("template-save").click();
    await expect(page.getByTestId("template-item").filter({ hasText: "Country by retail tier" })).toBeVisible();
    await page.getByRole("link", { name: "Budgets", exact: true }).click();
    await expect(page.getByTestId("template-picker").locator("option", { hasText: "Country by retail tier" })).toBeAttached();
  });

  test("the default granularities are there; an org admin adds a metric, a workspace admin is told why not", async ({ page }) => {
    await as(page, "admin");
    await page.goto(registry());
    await page.getByTestId("dimension-item").and(page.locator('[data-key="objective"]')).click();
    for (const code of ["brand", "non_brand", "competitor"]) await expect(row(page, code)).toBeVisible();
    await expect(page.getByTestId("dim-toggle")).toHaveCount(0); // org-wide: only an org admin changes it
    await page.goto(`${registry()}?tab=%22metrics%22`);
    await expect(page.getByTestId("metric-create")).toBeDisabled();

    await as(page, "orgAdmin");
    await page.goto(`${registry()}?tab=%22metrics%22`);
    await expect(page.getByTestId("metric-row").filter({ hasText: "cpa" }).first()).toBeVisible(); // the default library
    const before = await page.getByTestId("metric-row").count();
    await page.getByTestId("metric-label").fill("Cost per store visit");
    await page.getByTestId("metric-denominator").fill("kpi:store_visits");
    await page.getByTestId("metric-create").click();
    await expect(page.getByTestId("metric-row")).toHaveCount(before + 1);
    await expect(page.getByTestId("metric-row").filter({ hasText: "cost_per_store_visit" })).toContainText("spend ÷ store_visits");
  });
});
