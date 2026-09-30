import LZString from "lz-string";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * Product feedback 2026-09-28, tagging: tick budgets in the grid and tag them together (a new tag
 * created on the spot); filter Budgets by tag; tag chips on alerts (and approvals, targets).
 */

const FY = { kind: "relative", preset: "current_year" };
const enc = (v: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(v));
async function signIn(page: Page, persona: string): Promise<string> {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
}
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test("tag several budgets at once from the grid, creating the tag", async ({ page }) => {
  const token = await signIn(page, "orgAdmin");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/budgets?period=${encodeURIComponent(JSON.stringify(FY))}`);
  await page.getByTestId("template-picker").selectOption({ label: "Region first" });
  await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).not.toBe("");
  const templateId = new URL(page.url()).searchParams.get("templateId")?.replace(/"/g, "") ?? "";
  const tree = await api(token, "POST", `/workspaces/${ws}/tree`, { workspaceId: ws, templateId, period: FY, measures: ["budget"] });
  const rows = tree.body["rows"] as Array<{ nodeEnvelopeId: string | null }>;
  const parents = rows.map((r, i) => ({ i, id: r.nodeEnvelopeId })).filter((r) => r.id !== null).slice(0, 2);
  expect(parents).toHaveLength(2);

  await page.getByTestId("select-mode").click();
  await expect(page.getByTestId("bulk-tag-bar")).toBeVisible();
  const box = await page.getByTestId("explorer-grid").locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas not rendered");
  for (const p of parents) await page.mouse.click(box.x + 18, box.y + 40 + p.i * 36 + 18); // the row checkbox
  await expect(page.getByTestId("bulk-tag-count")).toHaveText("2 selected");

  const name = `e2e-bulk-${Date.now()}`;
  await page.getByTestId("bulk-tag-name").fill(name);
  await page.getByTestId("bulk-tag-add").click();
  await expect(page.getByText(`Tagged 2 budgets with “${name}”`)).toBeVisible();
  const applied = await api(token, "GET", `/workspaces/${ws}/tags/applied?type=envelope&ids=${parents.map((p) => p.id).join(",")}`);
  for (const p of parents) expect((applied.body[p.id as string] as Array<{ name: string }>).map((x) => x.name)).toContain(name);

  await page.getByTestId("bulk-tag-exit").click();
  await expect(page.getByTestId("bulk-tag-bar")).toHaveCount(0);
});

test("filter Budgets by tag", async ({ page }) => {
  const token = await signIn(page, "orgAdmin");
  const ws = state().workspaceId;
  const tag = await api(token, "POST", `/workspaces/${ws}/tags`, { name: `e2e-filter-${Date.now()}` });
  const leaves = await api(token, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: FY, filter: { logic: "and", children: [{ field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true }] }, measures: ["budget"], limit: 3 });
  const ids = (leaves.body["rows"] as Array<{ envelopeId: string }>).map((r) => r.envelopeId);
  await api(token, "POST", "/tags/apply", { tagId: tag.body["id"], entities: ids.map((id) => ({ type: "envelope", id })) });

  await page.goto(`/w/${ws}/budgets?view="pivot"&groupBy=${encodeURIComponent(JSON.stringify(["country"]))}&period=${encodeURIComponent(JSON.stringify(FY))}`);
  await page.getByTestId("filter-add").click();
  await page.getByTestId("filter-dimension").selectOption({ label: "Tag" });
  await page.getByTestId("filter-values-search").fill(String(tag.body["name"]));
  await page.locator(`[data-testid="filter-value-option"][data-value="${String(tag.body["name"])}"]`).click();
  await page.getByTestId("filter-apply").click();
  await expect(page.getByTestId("filter-chip")).toHaveText(`Tag: ${String(tag.body["name"])}`);
  expect(new URL(page.url()).searchParams.get("filter")).toBe(enc({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "in", value: [tag.body["name"]] }] }));
  await expect.poll(async () => Number(await page.getByTestId("explorer-grid").getAttribute("data-rows"))).toBeGreaterThan(0);
});

test("tag an alert from its row, creating the tag", async ({ page }) => {
  await signIn(page, "orgAdmin");
  await page.goto(`/w/${state().workspaceId}/alerts`);
  const row = page.getByTestId("alert-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("tag-add").click();
  const name = `e2e-alert-${Date.now()}`;
  await row.getByTestId("tag-find").fill(name);
  await row.getByTestId("tag-create").click();
  await expect(row.getByTestId("tag-chip")).toContainText(name);
});
