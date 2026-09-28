import { LIVE_LEAVES } from "@budget/domain";
import { goldenPlan } from "@budget/db";
import { expect, test, type Page } from "@playwright/test";
import { Decimal } from "decimal.js";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-039 (spec §26): manual result entry. A batch per channel and month; rows pasted into the grid
 * are saved as typed and validated by the server; "Send for approval" is disabled with a visible
 * reason while a row has a problem; once Finance approves, the rows are actuals of their budget.
 */

test.use({ viewport: { width: 1440, height: 1000 } });

async function signIn(page: Page, persona = "planner"): Promise<string> {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
}
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const KEYS = ["region", "country", "platform", "objective", "audience"] as const;

test("manual results: paste rows, see what to fix, send for approval; approved rows are actuals", async ({ page }) => {
  const token = await signIn(page);
  const ws = state().workspaceId;
  const leaf = goldenPlan().find((e) => e.level === 4 && e.key.startsWith("LATAM/MX/google_ads/"));
  if (!leaf) throw new Error("no MX google_ads leaf");
  const tuple = KEYS.map((k) => leaf.dimensionValues[k] ?? "");
  const actualOf = async () => {
    const res = await api(token, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: { kind: "range", start: "2026-07-01", end: "2026-07-31" }, filter: { logic: "and", children: [...LIVE_LEAVES, ...KEYS.map((k, i) => ({ field: { kind: "dimension", key: k }, op: "eq", value: tuple[i] }))] }, measures: ["actual"], limit: 1 });
    return new Decimal(String((res.body["totals"] as Record<string, string | null>)["actual"] ?? 0));
  };
  const before = await actualOf();

  await page.goto(`/w/${ws}/sources/manual?channel=%22ooh%22&cols=${encodeURIComponent(JSON.stringify(KEYS))}`);
  await expect(page.getByTestId("channel-ooh")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("batch-month").fill("2026-07");
  await page.getByTestId("batch-new").click();
  const editor = page.getByTestId("batch-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByTestId("batch-submit")).toBeDisabled();
  await expect(page.getByTestId("batch-submit-reason")).toHaveText("Add at least one row.");

  // Paste two rows at the first granularity column: one good, one with an unknown country.
  const grid = page.getByTestId("entry-grid").locator("canvas").first();
  const box = await grid.boundingBox();
  if (!box) throw new Error("grid canvas not rendered");
  await page.mouse.click(box.x + 64 + 70, box.y + 40 + 18);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const good = [...tuple, "2026-07-15", "USD", "2500.00", "60", "Billboards on Reforma"].join("\t");
  const bad = [tuple[0], "XX", ...tuple.slice(2), "2026-07-16", "USD", "400"].join("\t");
  await page.evaluate((text) => navigator.clipboard.writeText(text), `${good}\n${bad}`);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByTestId("entry-grid")).toHaveAttribute("data-rows", "2");
  await expect(page.getByTestId("batch-issues")).toContainText('unknown country "XX"');
  await expect(page.getByTestId("batch-submit")).toBeDisabled();
  await expect(page.getByTestId("batch-submit-reason")).toContainText('Rows to fix: 1 — row 2: unknown country "XX"');

  // Fix row 2 by pasting over it.
  await page.mouse.click(box.x + 64 + 70, box.y + 40 + 36 + 18);
  await page.evaluate((text) => navigator.clipboard.writeText(text), [...tuple, "2026-07-16", "USD", "400"].join("\t"));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByTestId("batch-issues")).toHaveCount(0);
  await expect(page.getByTestId("entry-grid")).toHaveAttribute("data-total", "2900.00");
  await expect(page.getByTestId("batch-submit")).toBeEnabled();
  await page.getByTestId("batch-submit").click();
  await expect(page.getByTestId("batch-status").first()).toHaveAttribute("data-status", "SUBMITTED");
  await expect(page.getByTestId("batch-submit")).toBeDisabled();
  const batchId = String(await editor.getAttribute("data-batch"));

  // Finance approves (the request shows the rows); then the rows are July actuals of that budget.
  const detail = await api(token, "GET", `/manual-entries/${batchId}`);
  const requestId = String(detail.body["approvalRequestId"]);
  const financeToken = await tokenFor("finance1");
  const financePage = await page.context().newPage();
  await financePage.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), financeToken);
  await financePage.goto(`/w/${ws}/approvals/${requestId}`);
  await expect(financePage.getByTestId("manual-entry-diff")).toBeVisible();
  await expect(financePage.getByTestId("manual-diff-row")).toHaveCount(2);
  await financePage.getByTestId("decide-approve").click();
  await expect(financePage.getByTestId("decision-done")).toBeVisible();
  await financePage.close();

  await page.reload();
  await expect(page.getByTestId("batch-approved")).toContainText("3 facts");
  expect((await actualOf()).minus(before).toFixed(2)).toBe("2900.00");
});
