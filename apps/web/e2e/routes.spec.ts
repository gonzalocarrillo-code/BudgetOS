import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * T-026 done-when: with a signed test JWT (no auth bypass), every §18.1 route opens inside the
 * shell for a golden workspace: the API answered /me and the registry for that token.
 */

const signIn = async (page: Page, token: string) => {
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};

const ROUTES: Array<[path: string, title: string | RegExp]> = [
  ["", "Overview"],
  ["/budgets", "Budgets"],
  ["/approvals", "Approvals"],
  ["/approvals/{request}", /Q4 retail push/], // the request's summary once loaded ("Approval request" is only the loading title)
  ["/targets", "Targets"],
  ["/experiments", "Experiments"],
  ["/experiments/{uuid}", "Experiment"],
  ["/sources/manual", "Manual result entry"],
  ["/alerts", "Alerts"],
  ["/search?q=meta", "Search"],
  ["/closures", "Closures"],
  ["/snapshots", "Snapshots"],
  ["/sources", "Spend data"],
  ["/admin/registry", "Registry"],
  ["/admin/policies", "Approval policies"],
  ["/admin/rules", "Pacing rules"],
  ["/admin/slack", "Slack"],
  ["/admin/settings", "Settings"],
  ["/admin/workspace", "Workspace"],
  ["/admin/roles", "Roles"],
  ["/admin/tags", "Tags"],
  ["/admin/sources", "Data sources"],
  ["/admin/naming", "Naming templates"],
  ["/admin/periods", "Fiscal calendar"],
  ["/admin/tours", "Tours"],
];

test.describe("web shell (T-026)", () => {
  for (const [path, title] of ROUTES) {
    test(`opens /w/$ws${path || "/"}`, async ({ page }) => {
      const s = state();
      await signIn(page, await tokenFor("admin"));
      const url = `/w/${s.workspaceId}${path.replace("{request}", s.approvalRequestId).replace("{uuid}", "0199b5a0-0000-7000-8000-00000000e001")}`;
      await page.goto(url);
      await expect(page.getByTestId("page-title")).toHaveText(title);
      await expect(page.getByTestId("workspace-switcher")).toHaveAttribute("data-value", s.workspaceId);
      await expect(page.getByTestId("user-email")).toHaveText(`admin@${s.slug}.golden.test`);
    });
  }

  test("/ goes to the caller's workspace; the search box lands on the results page", async ({ page }) => {
    const s = state();
    await signIn(page, await tokenFor("planner"));
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/w/${s.workspaceId}$`));
    await page.getByTestId("global-search").click();
    await page.getByTestId("search-input").fill("country:BR");
    await page.getByTestId("search-all").click();
    await expect(page.getByTestId("page-title")).toHaveText("Search");
    await expect(page.getByTestId("search-query")).toHaveText("country:BR");
  });

  test("Explorer search params are validated from the URL", async ({ page }) => {
    const s = state();
    await signIn(page, await tokenFor("planner"));
    await page.goto(`/w/${s.workspaceId}/budgets?view=%22pivot%22&measures=%5B%22budget%22%5D`);
    await expect(page.getByTestId("explorer-state")).toContainText("pivot · relative · budget");
  });

  test("no token, or a token the API rejects, is the sign-in screen", async ({ page }) => {
    const s = state();
    await page.goto(`/w/${s.workspaceId}/budgets`);
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await signIn(page, await tokenFor("admin", { key: "foreign" }));
    await page.goto(`/w/${s.workspaceId}/budgets`);
    await expect(page.getByTestId("sign-in")).toBeVisible();
  });

  test("a workspace the caller has no role in is refused, with a way back to their own (UX-004)", async ({ page }) => {
    await signIn(page, await tokenFor("admin"));
    await page.goto(`/w/0199b5a0-0000-7000-8000-00000000f00d/budgets`);
    const denied = page.getByTestId("no-access");
    await expect(denied.getByTestId("page-title")).toHaveText("You don't have access to this workspace");
    await expect(page.getByTestId("logo")).toBeVisible();
    await denied.getByTestId("denied-workspace").filter({ hasText: "Golden" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/w/${state().workspaceId}/home$`));
    await expect(page).toHaveTitle(/^Home · Golden · BudgetOS$/);
  });
});
