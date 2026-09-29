import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * The Snapshots page (product feedback round 7 follow-up): the place to keep, watch and open the
 * snapshots. Save one from the page, see it in the list, open it: header, the change since, and
 * the rows as the tree they were saved in; rename and archive it; download it as a CSV.
 */
const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const ws = () => state().workspaceId;

test.describe.configure({ mode: "serial" });
test.describe("Snapshots page", () => {
  const name = "Page test snapshot";

  test("save from the page, open it, read the tree, download the CSV", async ({ page }) => {
    await as(page, "finance1");
    await page.goto(`/w/${ws()}/snapshots`);
    await expect(page.getByTestId("page-title")).toHaveText("Snapshots");
    await page.getByTestId("save-snapshot").click();
    await page.getByTestId("snapshot-name").fill(name);
    await page.getByTestId("snapshot-kind").selectOption("other");
    await page.getByTestId("snapshot-save").click();

    const detail = page.getByTestId("snapshot-detail");
    await expect(detail).toBeVisible();
    await expect(page.getByTestId("snapshot-name")).toContainText(name);
    await expect(page).toHaveURL(/select=/);
    await expect(page.getByTestId("snapshot-report")).toBeVisible();
    const rows = page.getByTestId("snapshot-rows");
    await expect(rows).toBeVisible();
    const count = Number(await rows.getAttribute("data-count"));
    expect(count).toBeGreaterThan(100);
    // Roots first, then their children, as saved.
    await expect(page.getByTestId("snapshot-tree-row").first()).toHaveAttribute("data-depth", "0");
    await expect(page.getByTestId("snapshot-tree-row").nth(1)).toHaveAttribute("data-depth", "1");

    const download = page.waitForEvent("download");
    await page.getByTestId("snapshot-download").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^snapshot-page-test-snapshot\.csv$/);
    const text = (await (await file.createReadStream()).toArray()).join("");
    expect(text.split("\r\n")[0]).toContain("envelope_id,parent_id,depth,name");
  });

  test("rename and archive from the page; the list keeps it under Show archived", async ({ page }) => {
    const token = await as(page, "finance1");
    const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${ws()}/baselines`, { headers: { authorization: `Bearer ${token}`, "x-workspace-id": ws() } });
    const id = ((await res.json()) as { baselines: Array<{ id: string; name: string }> }).baselines.find((b) => b.name === name)?.id as string;
    await page.goto(`/w/${ws()}/snapshots?select=%22${id}%22`);
    await page.getByTestId("snapshot-rename").click();
    await page.getByTestId("snapshot-rename-input").fill(`${name} (renamed)`);
    await page.getByTestId("snapshot-rename-save").click();
    await expect(page.getByTestId("snapshot-name")).toContainText(`${name} (renamed)`);
    await page.getByTestId("snapshot-archive").click();
    await expect(page.getByTestId("snapshot-row").and(page.locator(`[data-name="${name} (renamed)"]`))).toHaveCount(0);
    await page.getByTestId("snapshots-show-archived").check();
    await expect(page.getByTestId("snapshot-row").and(page.locator(`[data-name="${name} (renamed)"]`))).toContainText("Archived");
  });

  test("the nav and Settings both lead here", async ({ page }) => {
    await as(page, "planner");
    await page.goto(`/w/${ws()}/admin/periods`);
    await page.getByTestId("snapshots-open-page").click();
    await expect(page.getByTestId("page-title")).toHaveText("Snapshots");
    await expect(page.getByTestId("snapshots-pick")).toBeVisible();
  });
});
