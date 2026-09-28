import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * No placeholders: the Roles and Tags admin pages work end to end. An org admin adds a person by
 * email and gives them a scoped role; a workspace admin manages roles but cannot add people; tags
 * are created, renamed, recoloured, merged and open their budgets.
 */

test.use({ viewport: { width: 1440, height: 900 } });
const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};

test("roles: add a person, give a role for Region LATAM only, then remove it", async ({ page }) => {
  await signIn(page, "orgAdmin");
  await page.goto(`/w/${state().workspaceId}/admin/roles`);
  await expect(page.getByTestId("principal").first()).toBeVisible();
  const email = `new.hire.${Date.now()}@example.test`;
  await page.getByTestId("person-email").fill(email);
  await page.getByTestId("person-name").fill("New Hire");
  await page.getByTestId("person-add").click();
  await expect(page.getByTestId("person-note")).toContainText(email);
  const person = page.getByTestId("principal").and(page.locator(`[data-email="${email}"]`));
  await expect(person).toContainText("Not signed in yet");

  await person.getByTestId("role-add").click();
  await person.getByTestId("role-select").selectOption("BUDGET_OWNER");
  await person.getByTestId("role-scope-dim").selectOption("region");
  await person.getByTestId("role-value-LATAM").check();
  await person.getByTestId("role-give").click();
  const chip = person.getByTestId("role-chip").and(page.locator('[data-role="BUDGET_OWNER"]'));
  await expect(chip).toContainText("Budget owner");
  await expect(chip).toContainText("LATAM");

  await chip.getByTestId("role-revoke").click();
  await expect(person.getByTestId("role-chip")).toHaveCount(0);
});

test("roles: a workspace admin manages roles but cannot add people; a planner cannot see them", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/admin/roles`);
  await expect(page.getByTestId("principal").first()).toBeVisible();
  await expect(page.getByTestId("person-add")).toHaveCount(0);
  const planners = page.getByTestId("principal").filter({ has: page.getByTestId("role-chip").and(page.locator('[data-role="PLANNER"]')) });
  await expect(planners.first()).toBeVisible();

  const other = await page.context().newPage();
  const token = await tokenFor("planner");
  await other.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  await other.goto(`/w/${state().workspaceId}/admin/roles`);
  await expect(other.getByTestId("roles-forbidden")).toBeVisible();
});

test("tags: create, rename and recolour, merge into another, and open a tag's budgets", async ({ page }) => {
  await signIn(page, "admin"); // creating and merging tags is an admin's (tag.create)
  await page.goto(`/w/${state().workspaceId}/admin/tags`);
  const stamp = Date.now();
  for (const name of [`launch-${stamp}`, `promo-${stamp}`]) {
    await page.getByTestId("tag-name").fill(name);
    await page.getByTestId("tag-create").click();
    await expect(page.getByTestId("tag-row").and(page.locator(`[data-name="${name}"]`))).toBeVisible();
  }
  const launch = page.getByTestId("tag-row").and(page.locator(`[data-name="launch-${stamp}"]`));
  await launch.getByTestId("tag-edit").click();
  await launch.getByTestId("tag-rename").fill(`launch-2026-${stamp}`);
  await launch.getByTestId("tag-color").nth(2).click();
  await launch.getByTestId("tag-save").click();
  const renamed = page.getByTestId("tag-row").and(page.locator(`[data-name="launch-2026-${stamp}"]`));
  await expect(renamed).toBeVisible();

  const promo = page.getByTestId("tag-row").and(page.locator(`[data-name="promo-${stamp}"]`));
  await promo.getByTestId("tag-merge").click();
  await promo.getByTestId("tag-merge-into").selectOption({ label: `launch-2026-${stamp}` });
  await promo.getByTestId("tag-merge-confirm").click();
  await expect(page.getByTestId("tag-row").and(page.locator(`[data-name="promo-${stamp}"]`))).toHaveCount(0);

  // The golden tag opens its budgets in the Explorer.
  await page.getByTestId("tag-row").and(page.locator('[data-name="q4-push"]')).getByTestId("tag-open").click();
  await expect(page).toHaveURL(/\/budgets\?.*filter=/);
  await expect(page.getByTestId("filter-chip")).toHaveCount(1);
});
