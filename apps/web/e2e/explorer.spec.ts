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
/** selectOption waits for the select, not for its options: wait until the option exists. */
const pick = async (page: Page, testId: string, option: { label: string } | string) => {
  const select = page.getByTestId(testId);
  const opt = typeof option === "string" ? select.locator(`option[value="${option}"]`) : select.locator("option", { hasText: option.label });
  await expect(opt.first()).toBeAttached();
  await select.selectOption(option);
};
const totalBudget = (page: Page) => page.getByTestId("explorer-grid").getAttribute("data-budget-total");

test.describe("Explorer (T-027)", () => {
  test("filter → URL → reload: the filter is in the URL and survives a reload", async ({ page }) => {
    await signIn(page);
    await page.goto(budgetsUrl({ period: FY }));
    await pick(page, "template-picker", { label: "Region first" });
    await page.getByTestId("filter-add").click();
    await pick(page, "filter-dimension", "region");
    await pick(page, "filter-values", "LATAM");
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
    await pick(page, "template-picker", { label: "Region first" });
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

  test("the tree's levels come from the roll-up cache, with /query's totals (ADR-038)", async ({ page }) => {
    const token = await signIn(page);
    const trees: Array<{ parentPath: string; available: boolean }> = [];
    page.on("response", (r) => {
      if (r.url().endsWith("/tree") && r.request().method() === "POST") void r.json().then((b: { available: boolean }) => trees.push({ parentPath: (JSON.parse(r.request().postData() ?? "{}") as { parentPath: string }).parentPath, available: b.available }));
    });
    await page.goto(budgetsUrl({ period: FY }));
    await pick(page, "template-picker", { label: "Region first" });
    await expect.poll(() => trees.some((t) => t.parentPath === "" && t.available)).toBe(true);
    const live = await api(token, "POST", `/workspaces/${state().workspaceId}/query`, { workspaceId: state().workspaceId, period: FY, filter: { logic: "and", children: LIVE_LEAVES }, groupBy: ["region"], measures: ["budget"], limit: 1 });
    await expect.poll(() => totalBudget(page)).toBe((live.body["totals"] as { budget: string }).budget);

    await page.goto(`${page.url()}&expanded=${enc(["LATAM"])}`);
    await expect.poll(() => trees.some((t) => t.parentPath === "LATAM" && t.available)).toBe(true);
    await expect(page.getByTestId("explorer-grid")).toBeVisible();
  });

  test("a parent budget opens in the drawer from its group row; the marker still expands it", async ({ page }) => {
    const token = await signIn(page);
    const ws = state().workspaceId;
    await page.goto(budgetsUrl({ period: FY }));
    await pick(page, "template-picker", { label: "Region first" });
    await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).not.toBe("");
    const templateId = new URL(page.url()).searchParams.get("templateId")?.replace(/"/g, "") ?? "";
    const tree = await api(token, "POST", `/workspaces/${ws}/tree`, { workspaceId: ws, templateId, period: FY, measures: ["budget"] });
    const rows = tree.body["rows"] as Array<{ key: string; nodeEnvelopeId: string | null }>;
    const index = rows.findIndex((r) => r.nodeEnvelopeId !== null);
    expect(index, "a first-level group that is a parent budget").toBeGreaterThanOrEqual(0);
    const parent = await api(token, "GET", `/envelopes/${rows[index]?.nodeEnvelopeId}`);
    const before = Number(await page.getByTestId("explorer-grid").getAttribute("data-rows"));

    const box = await page.getByTestId("explorer-grid").locator("canvas").first().boundingBox();
    if (!box) throw new Error("grid canvas not rendered");
    const y = box.y + 40 + index * 36 + 18; // header 40 px, row 36 px
    await page.mouse.click(box.x + 80, y); // the name
    await expect(page.getByTestId("drawer-name")).toHaveText(String(parent.body["displayName"] ?? parent.body["name"]));
    await expect(page).toHaveURL(new RegExp(`select=${rows[index]?.nodeEnvelopeId}`));
    await expect(page.getByTestId("drawer-children")).toBeVisible();

    await page.getByRole("button", { name: /close/i }).first().click();
    await page.mouse.click(box.x + 14, y); // the marker
    await expect.poll(async () => Number(await page.getByTestId("explorer-grid").getAttribute("data-rows"))).toBeGreaterThan(before);
  });

  test("send for approval: from the notice after an edit (auto-approved), and from the drawer (waiting, then withdrawn)", async ({ page }) => {
    const token = await signIn(page);
    const s = state();
    const found = await api(token, "POST", `/workspaces/${s.workspaceId}/query`, { workspaceId: s.workspaceId, period: FY, filter: { logic: "and", children: [...LIVE_LEAVES, { field: { kind: "dimension", key: "country" }, op: "eq", value: "DE" }] }, measures: ["budget"], sort: [{ key: "name", dir: "asc" }], limit: 20 });
    // Two leaves with no open draft (the golden data has some).
    const clean: Array<{ envelopeId: string; path: string[]; measures: { budget: string } }> = [];
    for (const r of found.body["rows"] as Array<{ envelopeId: string; path: string[]; measures: { budget: string } }>) {
      if (clean.length < 2 && (await api(token, "GET", `/envelopes/${r.envelopeId}`)).body["draft"] === null) clean.push(r);
    }
    const [small, large] = clean;
    expect(large, "two German leaves without a draft").toBeDefined();
    const edit = async (leaf: typeof small, amount: string) => {
      await page.goto(budgetsUrl({ period: FY, view: "pivot", filter: { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "eq", value: leaf?.path.at(-1) }] } }));
      await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).toBe("1");
      await page.waitForTimeout(300);
      const box = await page.getByTestId("explorer-grid").locator("canvas").first().boundingBox();
      if (!box) throw new Error("grid canvas not rendered");
      await page.mouse.dblclick(box.x + 340 + 75, box.y + 40 + 18);
      await page.keyboard.type(amount);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("notice-ok")).toBeVisible();
    };

    // +0.5 %: the notice offers Send for approval; the minor-change policy approves it at once.
    await edit(small, (Number(small?.measures.budget) * 1.005).toFixed(2));
    const notice = page.getByTestId("notice-ok");
    await expect(notice.getByTestId("approval-state")).toHaveAttribute("data-state", "draft");
    await notice.getByTestId("approval-send").click();
    await expect(notice.getByTestId("approval-state")).toHaveAttribute("data-state", "approved");
    await expect.poll(async () => ((await api(token, "GET", `/envelopes/${small?.envelopeId}`)).body["draft"] ?? null)).toBeNull();

    // ×3: sent from the drawer it waits for an approver, links to the request, and can be withdrawn
    // (the version is kept as WITHDRAWN; the budget is back to its approved amount).
    await edit(large, (Number(large?.measures.budget) * 3).toFixed(2));
    await page.getByTestId("notice-open").click();
    const drawer = page.getByTestId("envelope-drawer");
    await expect(drawer.getByTestId("approval-state")).toHaveAttribute("data-state", "draft");
    await drawer.getByTestId("approval-send").click();
    await expect(drawer.getByTestId("approval-state")).toHaveAttribute("data-state", "waiting");
    await expect(drawer.getByTestId("approval-open-request")).toHaveAttribute("href", /\/approvals\/[0-9a-f-]{36}$/);
    await drawer.getByTestId("approval-withdraw").click();
    await expect(drawer.getByTestId("approval-state")).toHaveAttribute("data-state", "withdrawn");
    expect((await api(token, "GET", `/envelopes/${large?.envelopeId}`)).body["draft"]).toBeNull();
  });

  test("edit a budget family top-down: the parent +10 %, a child follows by %, one approval for all", async ({ page }) => {
    const token = await signIn(page);
    const ws = state().workspaceId;
    const templates = (await api(token, "GET", `/workspaces/${ws}/hierarchy-templates`)).body as unknown as Array<{ id: string; name: string }>;
    const regionFirst = templates.find((x) => x.name === "Region first");
    const tree = await api(token, "POST", `/workspaces/${ws}/tree`, { workspaceId: ws, templateId: regionFirst?.id, period: FY, parentPath: "EMEA", measures: ["budget"] });
    // A country budget with no open draft of its own.
    let parentId = "";
    for (const r of tree.body["rows"] as Array<{ nodeEnvelopeId: string | null }>) {
      if (!parentId && r.nodeEnvelopeId && (await api(token, "GET", `/envelopes/${r.nodeEnvelopeId}`)).body["draft"] === null) parentId = r.nodeEnvelopeId;
    }
    expect(parentId, "an EMEA country budget without a draft").not.toBe("");
    const family = (await api(token, "GET", `/envelopes/${parentId}/family`)).body as { parent: { before: string }; members: Array<{ envelopeId: string; before: string }> };
    let row = -1;
    for (const [i, m] of family.members.entries()) if (row < 0 && (await api(token, "GET", `/envelopes/${m.envelopeId}`)).body["draft"] === null) row = i;
    expect(row, "a child without a draft").toBeGreaterThanOrEqual(0);

    await page.goto(`${budgetsUrl({ period: FY })}&select=${parentId}`);
    await expect(page.getByTestId("drawer-family-sum")).toBeVisible();
    await page.getByTestId("drawer-family-edit").click();
    const editor = page.getByTestId("family-editor");
    await expect(editor.getByTestId("family-row")).toHaveCount(family.members.length);
    const newParent = (Number(family.parent.before) * 1.1).toFixed(2);
    await editor.getByTestId("family-parent").fill(newParent);
    const child = editor.getByTestId("family-row").nth(row);
    await child.getByTestId("family-mode-percent").click();
    await expect(child).toHaveAttribute("data-mode", "percent");
    // The child keeps its share, so its result grows with the parent.
    const share = Number(family.members[row]?.before) / Number(family.parent.before);
    await expect.poll(async () => Math.abs(Number((await child.getByTestId("family-after").textContent())?.replace(/[^\d.]/g, "")) - Number(newParent) * share)).toBeLessThan(0.5); // the share is shown to 4 decimals
    await expect(editor.getByTestId("family-sum")).toHaveAttribute("data-status", /under|balanced/);
    await editor.getByTestId("family-rationale").fill("Top-down +10 %");
    await editor.getByTestId("family-review").click();

    const dialog = page.getByTestId("paste-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("paste-row")).toHaveCount(2);
    await dialog.getByTestId("paste-commit").click();
    await expect(page.getByTestId("notice-ok")).toBeVisible();
    const parent = await api(token, "GET", `/envelopes/${parentId}`);
    expect((parent.body["draft"] as { amount: string }).amount).toBe(newParent);
    const after = (await api(token, "GET", `/envelopes/${parentId}/family`)).body as { members: Array<{ envelopeId: string; mode: string | null }> };
    expect(after.members[row]?.mode).toBe("percent");
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
