import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * T-029 done-when (spec §22): the decide flow. The golden bulk change waits on a two-step chain
 * (budget owner, then approver). Each decides from their inbox with a comment; each decision is by
 * its account, with its comment, in the request's timeline; the requester cannot decide and is told
 * why; and the budgets' History tab (plan 0.6) shows the decisions.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};
const inbox = (tab = "mine") => `/w/${state().workspaceId}/approvals?tab=%22${tab}%22`;

test.describe.configure({ mode: "serial" });
test.describe("approvals (T-029)", () => {
  test("the requester sees the request but cannot decide, and is told why", async ({ page }) => {
    await as(page, "planner");
    await page.goto(`/w/${state().workspaceId}/approvals/${state().approvalRequestId}`);
    await expect(page.getByTestId("diff-row")).toHaveCount(24);
    await expect(page.getByTestId("decision-reason")).toBeVisible();
    await expect(page.getByTestId("decide-approve")).toBeDisabled();
  });

  test("decide flow: budget owner approves step 1, then the approver approves step 2", async ({ browser }) => {
    const owner = await browser.newPage();
    await as(owner, "budgetOwner");
    await owner.goto(inbox());
    await expect(owner.getByTestId("approval-row")).toHaveCount(1);
    await owner.getByTestId("approval-link").click();
    await expect(owner.getByTestId("chain-step").nth(0)).toHaveAttribute("aria-current", "step");
    await owner.getByTestId("decision-comment-input").fill("Q4 retail push fits the plan.");
    await owner.getByTestId("decide-approve").click();
    await expect(owner.getByTestId("decision-done")).toBeVisible();
    await expect(owner.getByTestId("chain-step").nth(1)).toHaveAttribute("aria-current", "step");
    await expect(owner.getByTestId("decision-entry")).toHaveCount(1);
    await expect(owner.getByTestId("decision-entry").first()).toContainText("Golden budgetOwner: Approve");
    await expect(owner.getByTestId("decision-comment").first()).toHaveText("Q4 retail push fits the plan.");
    await expect(owner.getByTestId("decision-reason")).toContainText("Step 2 needs an approver");
    await owner.goto(inbox());
    await expect(owner.getByTestId("approvals-empty")).toBeVisible();
    await owner.close();

    const approver = await browser.newPage();
    await as(approver, "approver");
    await approver.goto(inbox());
    await expect(approver.getByTestId("approval-row")).toHaveCount(1);
    await approver.getByTestId("approval-link").click();
    await expect(approver.getByTestId("decide-reject")).toBeDisabled(); // reject needs a comment
    await approver.getByTestId("decide-approve").click();
    await expect(approver.getByTestId("status-chip").first()).toHaveText("approved");
    await expect(approver.getByTestId("decision-entry")).toHaveCount(2);
    await expect(approver.getByTestId("decision-entry").nth(1)).toContainText("Golden approver: Approve");
    await approver.goto(inbox("resolved"));
    await expect(approver.getByTestId("approval-row").first()).toContainText("Q4 retail push");
    await approver.close();
  });

  test("every budget's drawer has a History tab with the decisions, by account", async ({ page }) => {
    await as(page, "planner");
    await page.goto(`/w/${state().workspaceId}/approvals/${state().approvalRequestId}`);
    await page.getByTestId("diff-row").first().getByRole("link").click();
    await expect(page.getByTestId("envelope-drawer")).toBeVisible();
    await page.getByTestId("drawer-tab-history").click();
    await expect(page.getByTestId("drawer-tab-history")).toHaveAttribute("aria-selected", "true");
    const entries = page.getByTestId("history-list").getByTestId("history-entry");
    await expect(entries.first()).toBeVisible();
    await expect(page.getByTestId("history-list")).toContainText("Golden budgetOwner");
    await expect(page.getByTestId("history-list")).toContainText("Golden approver");
    // Keyboard: arrows move between the tabs.
    await page.getByTestId("drawer-tab-history").press("ArrowLeft");
    await expect(page.getByTestId("drawer-tab-details")).toHaveAttribute("aria-selected", "true");
  });
});
