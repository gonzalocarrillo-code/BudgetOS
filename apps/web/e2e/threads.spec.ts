import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-030 done-when (spec §22): the mention flow. In a budget's Comments tab (plan 0.6: every budget
 * has one) the planner types "@bud", picks the budget owner from the autocomplete and posts; the
 * comment shows the mention by name. The budget owner reacts 👍, and the reaction names who
 * reacted. An edited comment says so, and its earlier version is one click away. Comments sit on
 * approval requests too; tag chips apply and remove; the Targets page proposes a new value.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};
/** Opens the first budget of the golden request in the drawer, on its Comments tab. */
const openComments = async (page: Page) => {
  await page.goto(`/w/${state().workspaceId}/approvals/${state().approvalRequestId}`);
  await page.getByTestId("diff-row").first().getByRole("link").click();
  await expect(page.getByTestId("envelope-drawer")).toBeVisible();
  await page.getByTestId("drawer-tab-comments").click();
  await expect(page.getByTestId("thread-panel")).toBeVisible();
};

test.describe.configure({ mode: "serial" });
test.describe("threads (T-030)", () => {
  test("mention flow: @bud → Golden budgetOwner, posted with the name", async ({ page }) => {
    await as(page, "planner");
    await openComments(page);
    const input = page.getByTestId("new-thread-input");
    await input.click();
    await input.pressSequentially("Can you confirm Q4? @bud");
    const option = page.getByTestId("mention-option").filter({ hasText: "Golden budgetOwner" });
    await expect(option).toBeVisible();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await input.press("Enter");
    await expect(input).toHaveValue("Can you confirm Q4? @Golden budgetOwner ");
    await input.pressSequentially("thanks");
    await page.getByTestId("new-thread-submit").click();
    const comment = page.getByTestId("comment").filter({ hasText: "Can you confirm Q4?" });
    await expect(comment).toBeVisible();
    await expect(comment.getByTestId("mention")).toHaveText("@Golden budgetOwner");
    await expect(comment.getByTestId("comment-author")).toHaveText("Golden planner");
    await expect(page.getByTestId("drawer-tab-comments")).toHaveText("Comments (1)");
  });

  test("the budget owner reacts 👍; the reaction is by account and names who", async ({ page }) => {
    await as(page, "budgetOwner");
    await openComments(page);
    const comment = page.getByTestId("comment").filter({ hasText: "Can you confirm Q4?" });
    await comment.getByTestId("reaction-add").click();
    await comment.getByTestId("react-thumbs-up").click();
    const chip = comment.getByTestId("reaction").and(page.locator('[data-emoji="👍"]'));
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(chip).toHaveAttribute("aria-label", /thumbs up, 1: Golden budgetOwner\. You reacted/);
    // The owner replies in the thread.
    await page.getByTestId("thread-reply").click();
    await page.getByTestId("reply-input").fill("Confirmed.");
    await page.getByTestId("reply-submit").click();
    await expect(page.getByTestId("comment").filter({ hasText: "Confirmed." })).toBeVisible();
  });

  test("the planner sees who reacted, edits the comment, and its earlier version stays visible", async ({ page }) => {
    await as(page, "planner");
    await openComments(page);
    const comment = page.getByTestId("comment").filter({ hasText: "Can you confirm Q4?" });
    const chip = comment.getByTestId("reaction").first();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(chip).toHaveAttribute("aria-label", "👍 thumbs up, 1: Golden budgetOwner");
    await comment.getByTestId("comment-edit").click();
    const edit = page.getByTestId("edit-comment-input");
    await expect(edit).toHaveValue("Can you confirm Q4? @Golden budgetOwner thanks");
    await edit.fill("Can you confirm Q4 and Q1? @Golden budgetOwner thanks");
    await page.getByTestId("edit-comment-submit").click();
    const edited = page.getByTestId("comment").filter({ hasText: "Q4 and Q1" });
    await expect(edited.getByTestId("mention")).toHaveText("@Golden budgetOwner"); // still a mention, not text
    const toggle = edited.getByTestId("comment-edited");
    await expect(toggle).toHaveText("edited (1)");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(edited.getByTestId("comment-history-body")).toHaveText("Can you confirm Q4? @Golden budgetOwner thanks");
    // Every budget's History tab records the comment activity too.
    await page.getByTestId("drawer-tab-history").click();
    await expect(page.getByTestId("history-list")).toContainText("Golden planner");
  });

  test("an approval request has its own comments", async ({ page }) => {
    await as(page, "approver");
    await page.goto(`/w/${state().workspaceId}/approvals/${state().approvalRequestId}`);
    const input = page.getByTestId("new-thread-input");
    await input.fill("Numbers look right for the retail push.");
    await page.getByTestId("new-thread-submit").click();
    await expect(page.getByTestId("comment").filter({ hasText: "retail push" }).getByTestId("comment-author")).toHaveText("Golden approver");
  });

  test("tag chips: apply a workspace tag to a budget and remove it", async ({ page }) => {
    const ws = state().workspaceId;
    const admin = await tokenFor("admin");
    const created = await page.request.post(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${ws}/tags`, { headers: { authorization: `Bearer ${admin}`, "x-workspace-id": ws }, data: { name: "reviewed", color: "#1877F2" } });
    expect([201, 409]).toContain(created.status());
    await as(page, "planner");
    await openComments(page);
    await page.getByTestId("drawer-tab-details").click();
    await expect(page.getByTestId("tag-chip")).toHaveText(["q4-push"]); // golden: q4-push on the EMEA × amazon leaves
    await page.getByTestId("tag-add").click();
    await page.getByTestId("tag-option").filter({ hasText: "reviewed" }).click();
    await expect(page.getByTestId("tag-chip")).toHaveText(["q4-push", "reviewed"]);
    await page.getByRole("button", { name: "Remove tag reviewed" }).click();
    await expect(page.getByTestId("tag-chip")).toHaveText(["q4-push"]);
  });

  test("targets: the list, a target's versions, a new value through submit, and its comments", async ({ page }) => {
    await as(page, "planner");
    await page.goto(`/w/${state().workspaceId}/targets`);
    await expect(page.getByTestId("target-row").first()).toBeVisible();
    await page.getByTestId("target-row").first().click();
    await expect(page.getByTestId("target-drawer")).toBeVisible();
    await expect(page.getByTestId("target-version").first()).toBeVisible(); // loaded before counting
    const before = await page.getByTestId("target-version").count();
    await page.getByTestId("target-value").fill("42.5");
    await page.getByTestId("target-submit").click();
    await expect(page.getByTestId("target-done")).toBeVisible();
    await expect(page.getByTestId("target-version")).toHaveCount(before + 1);
    await page.getByTestId("target-tab-comments").click();
    await page.getByTestId("new-thread-input").fill("Tightened after the Q3 read-out.");
    await page.getByTestId("new-thread-submit").click();
    await expect(page.getByTestId("comment").filter({ hasText: "Tightened" })).toBeVisible();
  });
});
