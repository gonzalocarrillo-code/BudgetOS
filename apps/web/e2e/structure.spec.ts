import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-031b done-when (plan 0.6 §9.3): add child, move under and split from the tree toolbar and the
 * drawer, each through its preview (the server runs the change and rolls it back) and approval.
 * A new child is new money: the Standard policy routes it to the budget owner, then the approver.
 * A split keeps the total, so the minor-change policy approves it; a move applies at once, and a
 * move over a full parent's cap is refused with Commit saying why.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const api = async (token: string, path: string) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, "x-workspace-id": state().workspaceId } });
  return (await res.json()) as Record<string, unknown>;
};
/** An envelope's id by its exact name, through search. */
const idOf = async (token: string, name: string) => {
  const res = await api(token, `/workspaces/${state().workspaceId}/search?q=${encodeURIComponent(name)}&types=envelope&limit=20`);
  const hits = ((res["groups"] as Array<{ type: string; hits: Array<{ id: string; title: string }> }>).find((g) => g.type === "envelope")?.hits ?? []).filter((h) => h.title === name);
  if (!hits[0]) throw new Error(`no envelope named ${name}`);
  return hits[0].id;
};
const budgets = (select: string) => `/w/${state().workspaceId}/budgets?select=%22${select}%22`;

test.describe.configure({ mode: "serial" });
test.describe("envelope structure from the UI (T-031b)", () => {
  test("add child from the tree toolbar: preview, submit, then the budget owner and the approver approve it", async ({ page, browser }) => {
    const token = await as(page, "planner");
    const parent = await idOf(token, "LATAM MX meta awareness");
    await page.goto(budgets(parent));
    await expect(page.getByTestId("drawer-name")).toHaveText("LATAM MX meta awareness");
    await page.getByTestId("structure-actions").getByTestId("structure-add_child").click();
    const dialog = page.getByTestId("structure-dialog");
    await expect(dialog).toHaveAttribute("data-op", "add_child");
    await expect(page.getByTestId("structure-commit")).toBeDisabled(); // nothing filled in yet
    await page.getByTestId("child-name").fill("MX meta awareness lookalike");
    await page.getByTestId("child-amount").fill("500.00");
    await page.getByTestId("child-dim").and(page.locator('[data-key="audience"]')).selectOption("lookalike");
    await page.getByTestId("structure-reason").fill("Test a lookalike audience in Q4");
    const preview = page.getByTestId("structure-preview");
    await expect(preview).toHaveAttribute("data-ok", "true");
    await expect(preview.getByTestId("preview-cap")).toContainText("Under LATAM MX meta awareness");
    await expect(page.getByTestId("preview-routing")).toHaveAttribute("data-kind", "approval");
    await expect(page.getByTestId("preview-routing")).toContainText("budget owner");
    await page.getByTestId("structure-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("Submitted for approval");
    await expect(page.getByTestId("drawer-child").filter({ hasText: "MX meta awareness lookalike" })).toBeVisible();
    const requestUrl = await page.getByTestId("notice-request").getAttribute("href");
    expect(requestUrl).toMatch(/\/approvals\//);

    for (const persona of ["budgetOwner", "approver"]) {
      const p = await browser.newPage();
      await as(p, persona);
      await p.goto(requestUrl as string);
      await p.getByTestId("decide-approve").click();
      await expect(p.getByTestId("decision-done")).toBeVisible();
      await p.close();
    }
    await page.reload();
    const child = page.getByTestId("drawer-child").filter({ hasText: "MX meta awareness lookalike" });
    await expect(child).toContainText("500.00");
  });

  test("move under from the drawer: over a full parent's cap it is refused and says why; to the top level it applies", async ({ page }) => {
    const token = await as(page, "planner");
    const leaf = await idOf(token, "MX meta awareness prospecting");
    await page.goto(budgets(leaf));
    await page.getByTestId("drawer-structure-actions").getByTestId("structure-move").click();
    await page.getByTestId("move-search").fill("LATAM MX google_ads awareness");
    await page.getByTestId("move-option").filter({ hasText: "LATAM MX google_ads awareness" }).first().click();
    await page.getByTestId("structure-reason").fill("Re-org under search");
    const preview = page.getByTestId("structure-preview");
    await expect(preview).toHaveAttribute("data-ok", "false");
    await expect(preview).toContainText("above its budget");
    await expect(page.getByTestId("structure-commit")).toBeDisabled();

    await page.getByTestId("move-top").click();
    await expect(preview).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("preview-routing")).toHaveAttribute("data-kind", "immediate");
    await expect(preview.getByTestId("preview-cap")).toContainText("Leaves LATAM MX meta awareness");
    await page.getByTestId("structure-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("was moved");
    await expect(page.getByTestId("drawer-structure")).toContainText("Top level (no parent)");
    await page.getByTestId("drawer-tab-history").click();
    await expect(page.getByTestId("history-list")).toContainText("Golden planner");
  });

  test("split from the drawer: two even parts, approved by the minor-change policy, and the source retires", async ({ page }) => {
    const token = await as(page, "planner");
    const leaf = await idOf(token, "MX meta awareness retargeting");
    await page.goto(budgets(leaf));
    await page.getByTestId("drawer-structure-actions").getByTestId("structure-split").click();
    await expect(page.getByTestId("split-part")).toHaveCount(2);
    await page.getByTestId("split-name").nth(0).fill("MX meta retargeting · web");
    await page.getByTestId("split-name").nth(1).fill("MX meta retargeting · app");
    await page.getByTestId("structure-reason").fill("Separate web and app");
    await expect(page.getByTestId("structure-preview")).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("preview-routing")).toHaveAttribute("data-kind", "auto_approved");
    // Parts that do not add up are refused before anything is written.
    const first = page.getByTestId("split-amount").nth(0);
    const original = await first.inputValue();
    await first.fill("1.00");
    await expect(page.getByTestId("structure-preview")).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("structure-commit")).toBeDisabled();
    await first.fill(original);
    await expect(page.getByTestId("structure-preview")).toHaveAttribute("data-ok", "true");
    await page.getByTestId("structure-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("Approved by policy");
    // The parts are the parent's children now (read from the tree, not the asynchronous search index).
    const source = await api(token, `/envelopes/${leaf}`);
    expect(source["status"]).toBe("ARCHIVED");
    const parent = await api(token, `/envelopes/${String(source["parentId"])}`);
    const children = (parent["structure"] as { children: Array<{ name: string; approved: string | null }> }).children;
    expect(children.find((c) => c.name === "MX meta retargeting · web")?.approved).toBe(original);
    expect(children.map((c) => c.name)).toContain("MX meta retargeting · app");
    expect(children.map((c) => c.name)).not.toContain("MX meta awareness retargeting");
  });
});
