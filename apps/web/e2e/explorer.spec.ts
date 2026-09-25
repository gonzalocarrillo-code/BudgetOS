import { LIVE_LEAVES } from "@budget/domain";
import { expect, test, type Page } from "@playwright/test";
import { Decimal } from "decimal.js";
import LZString from "lz-string";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-027 done-when (spec §22): filter → URL → reload; the inline edit conflict flow; pivot totals ==
 * tree totals. The grid draws on canvas, so rows are read from the /query responses the page made
 * and from the DOM totals row; cells are edited by position.
 */

const FY = { kind: "relative", preset: "current_year" };
const enc = (v: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(v));
const signIn = async (page: Page, persona = "planner") => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const budgetsUrl = (search: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) q.set(k, k === "filter" || k === "expanded" ? enc(v) : typeof v === "string" ? v : JSON.stringify(v));
  return `/w/${state().workspaceId}/budgets?${q.toString()}`;
};
const totalBudget = (page: Page) => page.getByTestId("explorer-grid").getAttribute("data-budget-total");

test.describe("Explorer (T-027)", () => {
  test("filter → URL → reload: the filter is in the URL and survives a reload", async ({ page }) => {
    await signIn(page);
    await page.goto(budgetsUrl({ period: FY }));
    await page.getByTestId("template-picker").selectOption({ label: "Region first" });
    await page.getByTestId("filter-add").click();
    await page.getByTestId("filter-dimension").selectOption("region");
    await page.getByTestId("filter-values").selectOption("LATAM");
    await page.getByTestId("filter-apply").click();
    await expect(page.getByTestId("filter-chip")).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]filter=[A-Za-z0-9+\-$]+/);
    await expect.poll(() => totalBudget(page)).toBe("565373.37");

    await page.reload();
    await expect(page.getByTestId("filter-chip")).toHaveCount(1);
    await expect(page.getByTestId("filter-chip")).toContainText("Region");
    await expect(page.getByTestId("template-picker").locator("option:checked")).toHaveText("Region first");
    await expect.poll(() => totalBudget(page)).toBe("565373.37");
  });

  test("pivot totals == tree totals, and the pivot's rows add up to them", async ({ page }) => {
    await signIn(page);
    await page.goto(budgetsUrl({ period: FY }));
    await page.getByTestId("template-picker").selectOption({ label: "Region first" });
    await expect.poll(() => totalBudget(page)).not.toBe("");
    const treeTotal = await totalBudget(page);
    const treeText = await page.getByTestId("grid-totals").locator('[data-column="budget"]').textContent();

    const pivotRows = page.waitForResponse(async (r) => r.url().endsWith("/query") && r.request().method() === "POST" && JSON.parse(r.request().postData() ?? "{}").groupBy?.[0] === "country");
    await page.getByTestId("view-pivot").click();
    await page.getByTestId("group-country").click();
    const body = (await (await pivotRows).json()) as { rows: Array<{ measures: { budget: string | null } }>; totals: { budget: string } };
    await expect.poll(() => totalBudget(page)).toBe(treeTotal);
    await expect(page.getByTestId("grid-totals").locator('[data-column="budget"]')).toHaveText(treeText ?? "");
    const sum = body.rows.reduce((s, r) => s.plus(r.measures.budget ?? 0), new Decimal(0));
    expect(sum.toFixed(2)).toBe(treeTotal);
    expect(body.totals.budget).toBe(treeTotal);
  });

  test("inline edit conflict: a stale edit shows the current value; reload, then the edit saves", async ({ page }) => {
    const token = await signIn(page);
    const s = state();
    // One live LATAM leaf, as the grid will show it.
    const found = await api(token, "POST", `/workspaces/${s.workspaceId}/query`, { workspaceId: s.workspaceId, period: FY, filter: { logic: "and", children: [...LIVE_LEAVES, { field: { kind: "dimension", key: "country" }, op: "eq", value: "BR" }] }, measures: ["budget"], sort: [{ key: "name", dir: "asc" }], limit: 1 });
    const leaf = (found.body["rows"] as Array<{ envelopeId: string; versionId: string; path: string[] }>)[0];
    expect(leaf).toBeDefined();
    const name = leaf?.path.at(-1) as string;
    await page.goto(budgetsUrl({ period: FY, view: "pivot", filter: { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "eq", value: name }] } }));
    await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).toBe("1");

    // Someone else changes the envelope after the page loaded it.
    const other = await api(await tokenFor("budgetOwner"), "PATCH", `/envelopes/${leaf?.envelopeId}/draft`, { amount: "12345.67", basedOnVersionId: leaf?.versionId });
    expect(other.status, JSON.stringify(other.body)).toBe(200);

    const editBudget = async (value: string) => {
      const canvas = page.getByTestId("explorer-grid").locator("canvas").first();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("grid canvas not rendered");
      await page.mouse.dblclick(box.x + 340 + 75, box.y + 40 + 18); // name column is 340 px, header 40 px, row 36 px
      await page.keyboard.type(value);
      await page.keyboard.press("Enter");
    };
    await editBudget("999.99");
    await expect(page.getByTestId("edit-conflict")).toBeVisible();
    await expect(page.getByTestId("edit-conflict-body")).toContainText("12,345.67");

    const reloaded = page.waitForResponse((r) => r.url().endsWith("/query") && r.request().method() === "POST");
    await page.getByTestId("edit-conflict-reload").click();
    await reloaded;
    await expect(page.getByTestId("edit-conflict")).toHaveCount(0);
    await page.waitForTimeout(300); // the reloaded rows reach the canvas
    await editBudget("999.99");
    await expect(page.getByTestId("notice-ok")).toBeVisible();
    const after = await api(token, "GET", `/envelopes/${leaf?.envelopeId}`);
    expect((after.body["draft"] as { amount: string }).amount).toBe("999.99");
  });

  test("paste never writes cells: it opens the bulk preview, and only Commit saves drafts", async ({ page }) => {
    const token = await signIn(page);
    const s = state();
    const found = await api(token, "POST", `/workspaces/${s.workspaceId}/query`, { workspaceId: s.workspaceId, period: FY, filter: { logic: "and", children: [...LIVE_LEAVES, { field: { kind: "dimension", key: "country" }, op: "eq", value: "MX" }] }, measures: ["budget"], sort: [{ key: "name", dir: "asc" }], limit: 1 });
    const leaf = (found.body["rows"] as Array<{ envelopeId: string; path: string[] }>)[0];
    await page.goto(budgetsUrl({ period: FY, view: "pivot", filter: { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "eq", value: leaf?.path.at(-1) }] } }));
    await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).toBe("1");
    const box = await page.getByTestId("explorer-grid").locator("canvas").first().boundingBox();
    if (!box) throw new Error("grid canvas not rendered");
    await page.mouse.click(box.x + 340 + 75, box.y + 40 + 18);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("4321.00"));
    await page.keyboard.press("ControlOrMeta+V");
    await expect(page.getByTestId("paste-dialog")).toBeVisible();
    await expect(page.getByTestId("paste-row")).toHaveCount(1);
    const before = await api(token, "GET", `/envelopes/${leaf?.envelopeId}`);
    expect(before.body["draft"]).toBeNull();
    await page.getByTestId("paste-commit").click();
    await expect(page.getByTestId("notice-ok")).toBeVisible();
    const after = await api(token, "GET", `/envelopes/${leaf?.envelopeId}`);
    expect((after.body["draft"] as { amount: string } | null)?.amount ?? (after.body["current"] as { amount: string }).amount).toBe("4321.00");
  });

  test("saved views: save the current params, then loading one restores them", async ({ page }) => {
    await signIn(page);
    await page.goto(budgetsUrl({ period: FY, view: "pivot", groupBy: ["region"] }));
    await page.getByTestId("saved-view-save").click();
    await page.getByTestId("saved-view-name").fill("Pivot by region");
    await page.getByTestId("saved-view-submit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("Pivot by region");
    await page.goto(budgetsUrl({}));
    await page.getByTestId("saved-views").selectOption({ label: "Pivot by region" });
    await expect(page.getByTestId("view-pivot")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("group-region")).toHaveAttribute("aria-pressed", "true");
  });
});
