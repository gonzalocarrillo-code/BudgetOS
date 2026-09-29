import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * H-011 / H-012 done-when (docs/BUDGET_HISTORY_PLAN.md §2.8): end a budget from the drawer, with
 * the spend to the last day proposed as its final amount and a successor started in the same
 * change; the ended budget reads "Ended", is read-only and links to what continues it; an ended
 * budget can be reintroduced again on its own.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const idOf = async (token: string, name: string) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${state().workspaceId}/search?q=${encodeURIComponent(name)}&types=envelope&limit=20`, { headers: { authorization: `Bearer ${token}`, "x-workspace-id": state().workspaceId } });
  const body = (await res.json()) as { groups: Array<{ type: string; hits: Array<{ id: string; title: string }> }> };
  const hit = (body.groups.find((g) => g.type === "envelope")?.hits ?? []).find((h) => h.title === name);
  if (!hit) throw new Error(`no envelope named ${name}`);
  return hit.id;
};
const budgets = (select: string) => `/w/${state().workspaceId}/budgets?select=%22${select}%22`;

test.describe.configure({ mode: "serial" });
test.describe("end and reintroduce a budget (H-011, H-012)", () => {
  const name = "FR meta conversion prospecting";
  const successor = `${name} · relaunch`;

  test("end from the drawer with a successor: spend proposed, applied at once for an admin, then read-only and linked", async ({ page }) => {
    const token = await as(page, "admin");
    await page.goto(budgets(await idOf(token, name)));
    await expect(page.getByTestId("drawer-name")).toHaveText(name);
    await page.getByTestId("drawer-structure-actions").getByTestId("structure-end").click();
    const dialog = page.getByTestId("structure-dialog");
    await expect(dialog).toHaveAttribute("data-op", "end");
    // The spend to the last day is proposed as the final amount.
    await expect(page.getByTestId("end-spend")).toBeVisible();
    await expect(page.getByTestId("end-final-amount")).toHaveValue(/^\d+\.\d{2}$/);
    await page.getByTestId("end-with-successor").check();
    await expect(page.getByTestId("successor-fields")).toBeVisible();
    await page.getByTestId("successor-name").fill(successor);
    const preview = page.getByTestId("structure-preview");
    await expect(preview).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("preview-routing")).toHaveAttribute("data-kind", "auto_approved");
    await page.getByTestId("structure-reason").fill("Campaign stopped; relaunching next month");
    await expect(preview).toHaveAttribute("data-ok", "true");
    await page.getByTestId("structure-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText(`${name} has ended`);

    await expect(page.getByTestId("drawer-status")).toHaveText("Ended");
    await expect(page.getByTestId("drawer-ended")).toContainText("Campaign stopped");
    const actions = page.getByTestId("drawer-structure-actions");
    await expect(actions.getByTestId("structure-end")).toHaveCount(0);
    await expect(actions.getByTestId("structure-reintroduce")).toBeEnabled();
    await expect(page.getByTestId("drawer-continued-by")).toContainText(successor);

    await page.getByTestId("drawer-continued-by").getByRole("link", { name: new RegExp(successor) }).click();
    await expect(page.getByTestId("drawer-name")).toHaveText(successor);
    await expect(page.getByTestId("drawer-continues")).toContainText(name);
    await expect(page.getByTestId("drawer-status")).toHaveText("Approved");
  });

  test("reintroduce an ended budget on its own", async ({ page }) => {
    const token = await as(page, "admin");
    await page.goto(budgets(await idOf(token, name)));
    await expect(page.getByTestId("drawer-status")).toHaveText("Ended");
    await page.getByTestId("drawer-structure-actions").getByTestId("structure-reintroduce").click();
    await expect(page.getByTestId("structure-dialog")).toHaveAttribute("data-op", "reintroduce");
    await page.getByTestId("successor-name").fill(`${name} · Q1`);
    await page.getByTestId("successor-amount").fill("1.00");
    await expect(page.getByTestId("structure-preview")).toHaveAttribute("data-ok", "true");
    await page.getByTestId("structure-commit").click();
    await expect(page.getByTestId("notice-ok")).toBeVisible();
    await expect(page.getByTestId("drawer-continued-by")).toContainText(`${name} · Q1`);
  });
});
