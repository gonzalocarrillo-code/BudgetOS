import { LIVE_LEAVES } from "@budget/domain";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";
import { as } from "./ops.js";

/**
 * The Overview (T-033, docs/HOME_OVERVIEW_PLAN.md §3.2, HO-011..HO-015): the state of the money in
 * one request, rendered in < 1.5 s on the small golden. The headline in money, pace by any two
 * granularities with their margins, what needs attention by money at stake, alerts by rule, CPA
 * against target, the approval queue and where the numbers come from. Every number is the API's.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Json = Record<string, unknown>;
interface Margin { code: string | null; spend_to_date_pct?: string | null; pace_index?: string | null; budget?: string | null }
interface Overview {
  period: { preset: string; start: string; end: string };
  totals: Record<string, string | null>;
  headline: { projected: string | null; unassigned: string | null };
  heatmap: { rows: string[]; cols: string[]; labels: { rows: Record<string, string>; cols: Record<string, string> }; rowTotals: Margin[]; colTotals: Margin[]; total: Margin };
  attention: { all: Array<{ name: string; money: string; category: string }>; over: Array<{ name: string }> };
  alerts: { open: number; byRule: Array<{ ruleId: string; ruleName: string | null }> };
  queue: { waiting: number; overdue: number };
  compare: { id: string; name: string } | null;
}
const ws = () => state().workspaceId;
const api = async <T = Json>(persona: string, method: string, path: string, body?: unknown): Promise<T> => {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(persona)}`, "x-workspace-id": ws(), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = (res.status === 204 ? {} : await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const pct = (v: string | null | undefined) => `${Math.round(Number(v) * 100)}%`;
const pace = (v: string | null | undefined) => `Pace ${Number(v).toFixed(2)}`;
const ready = (page: Page) => expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
const open = async (page: Page, persona: string, query = "") => {
  await as(page, persona);
  await page.goto(`/w/${ws()}${query}`);
  await ready(page);
};
/** Drops a persona's own Overview layout, so the test starts from the workspace default. */
const dropLayout = async (persona: string) => {
  const me = await api<{ user: { id: string } }>(persona, "GET", "/me");
  const views = await api<Array<{ id: string; createdBy: string; visibility: string }>>(persona, "GET", `/workspaces/${ws()}/saved-views?screen=overview`);
  for (const v of views.filter((x) => x.createdBy === me.user.id && x.visibility === "private")) await api(persona, "DELETE", `/saved-views/${v.id}`);
};

test("overview: every block, in under 1.5 s", async ({ page }) => {
  test.setTimeout(60_000);
  await as(page, "budgetOwner");
  await dropLayout("budgetOwner");
  await page.goto(`/w/${ws()}/alerts`);
  await expect(page.getByTestId("page-title")).toHaveText("Alerts");

  // First visit: Vite's dev server compiles and serves the route's modules (a production bundle has them already).
  const cold = Date.now();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true", { timeout: 30_000 }); // compiling, not rendering
  test.info().annotations.push({ type: "first visit (dev modules)", description: `${Date.now() - cold} ms` });

  // The dashboard itself: a new period is a new request (never cached), then every block renders.
  // Checked on every frame: `expect` polls with a back-off (100, 250, 500, 1000 ms) that would round
  // a page ready at 0.9 s up to 1.85 s.
  const started = Date.now();
  await page.getByTestId("overview-period").selectOption("ytd");
  await page.waitForFunction(
    (period) => {
      const o = document.querySelector('[data-testid="overview"]');
      return o?.getAttribute("data-period") === period && o.getAttribute("data-ready") === "true" && document.querySelector('[data-testid="heatmap-cell"]') !== null && document.querySelector('[data-testid="overview-freshness"]') !== null;
    },
    "ytd",
    { polling: "raf" },
  );
  const elapsed = Date.now() - started;
  await expect(page.getByTestId("heatmap-cell").first()).toBeVisible();
  await expect(page.getByTestId("overview-freshness")).toBeVisible();
  test.info().annotations.push({ type: "overview render", description: `${elapsed} ms` });
  expect(elapsed).toBeLessThan(1500);
  await page.getByTestId("overview-period").selectOption("current_year");
  await expect(page.getByTestId("overview")).toHaveAttribute("data-period", "current_year");
  await ready(page);

  // Every block, in the default order.
  await expect(page.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,kpi,queue,data");
  await expect(page.getByTestId("heatmap-row").and(page.locator('[data-code="BR"]'))).toContainText("Brazil");
  await expect(page.getByTestId("heatmap-legend")).toContainText("on plan");
  await expect(page.getByTestId("attention-row").first()).toBeVisible();
  await expect(page.getByTestId("kpi-row").first()).toBeVisible();
  await expect(page.getByTestId("overview-alerts")).toContainText(/Alerts · \d+ open/);
  await expect(page.getByTestId("overview-approvals")).toBeVisible();
  await expect(page.getByTestId("overview-freshness")).toContainText("Actuals through Aug 31, 2026");
  await expect(page.getByTestId("overview-as-of")).toContainText("Actuals through Aug 31, 2026");
  await expect(page.getByTestId("freshness-source").filter({ hasText: "Golden actuals (CSV)" })).toContainText("Golden actuals (CSV)");

  // Cells read as % of the budget spent; the axes are the user's pick, kept in the URL (feedback 8).
  await expect(page.getByTestId("heatmap-spent").first()).toHaveText(/^\d+%$/);
  await expect(page.getByTestId("tile-spent")).toContainText("of the period gone by Aug 31");
  await page.getByTestId("heatmap-cols").selectOption("objective");
  await expect(page).toHaveURL(/cols=%22objective%22|cols=objective/);
  await expect(page.getByTestId("heatmap-col").first()).toBeVisible();
  await page.getByTestId("heatmap-cols").selectOption("platform");
  await expect(page.getByTestId("heatmap-col").and(page.locator('[data-code="meta"]'))).toBeVisible();

  // A cell's popover opens the same budgets in the Explorer pivot.
  await page.getByTestId("heatmap-row").and(page.locator('[data-code="BR"]')).getByTestId("heatmap-cell").first().click();
  await expect(page.getByTestId("cell-popover")).toContainText("Brazil ×");
  await page.getByTestId("cell-open-budgets").click();
  await expect(page).toHaveURL(/\/budgets\?.*view=pivot/);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
});

/** HO-012: four tiles about money; Projected close only with projections (the golden has none). */
test("overview: the headline is money, and says what it is counted through", async ({ page }) => {
  await open(page, "budgetOwner");
  const o = await api<Overview>("budgetOwner", "GET", `/workspaces/${ws()}/overview`);
  await expect(page.getByTestId("tile-budget")).toContainText("Budget · This fiscal year");
  if (o.headline.unassigned !== null && Number(o.headline.unassigned) > 0) await expect(page.getByTestId("tile-budget-assigned")).toContainText("split into the budgets below");
  await expect(page.getByTestId("tile-spent")).toContainText(/USD\s?[\d.]+[kM]? · \d+%/); // the unit sits apart, small
  await expect(page.getByTestId("tile-remaining")).toContainText(/\d+ days left/);
  expect(o.headline.projected).toBeNull();
  await expect(page.getByTestId("tile-projected")).toHaveCount(0);
  await expect(page.getByTestId("overview-freshness")).toContainText("no projections loaded");
  // "Since the plan": the golden's FY2026 plan snapshot, and a way to Budgets comparing with it.
  await expect(page.getByTestId("tile-since")).toContainText("since FY2026 plan");
});

/** HO-011: the period picker shares Budgets' periods; Compare to adds the snapshot to every cell. */
test("overview: a fiscal quarter means the same days as on Budgets; Compare to shows the change", async ({ page }) => {
  await open(page, "budgetOwner");
  const option = page.getByTestId("overview-period").locator('option[value^="fiscal:"]').first();
  const value = (await option.getAttribute("value")) ?? "";
  const label = (await option.textContent()) ?? "";
  expect(value).toMatch(/^fiscal:/);
  const response = page.waitForResponse((r) => r.url().includes("/overview?") && decodeURIComponent(r.url()).includes(`period=${value}`));
  await page.getByTestId("overview-period").selectOption(value);
  const o = (await (await response).json()) as Overview;
  await expect(page.getByTestId("overview")).toHaveAttribute("data-period", value);
  expect(label).toContain(`${o.period.start} – ${o.period.end}`);
  // The same period in Budgets: the same option, and the same leaf total for it.
  const key = value.slice("fiscal:".length);
  const q = await api<{ totals: Record<string, string | null> }>("budgetOwner", "POST", `/workspaces/${ws()}/query`, { workspaceId: ws(), period: { kind: "fiscal", key }, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["budget"], limit: 1 });
  expect(q.totals["budget"]).toBe(o.totals["budget"]);
  await page.goto(`/w/${ws()}/budgets`);
  await page.getByTestId("period-picker").selectOption(value);
  await expect(page.getByTestId("period-picker").locator("option:checked")).toHaveText(label);

  // Compare to: the snapshot's budget in every cell's popover, and the change in the headline.
  await page.goto(`/w/${ws()}`);
  await ready(page);
  const snapshot = page.getByTestId("overview-compare").locator("option[value]:not([value=''])").first();
  const snapshotId = (await snapshot.getAttribute("value")) ?? "";
  await page.getByTestId("overview-compare").selectOption(snapshotId);
  await expect(page).toHaveURL(new RegExp(`compareTo=(%22)?${snapshotId}`));
  await ready(page);
  await expect(page.getByTestId("tile-since")).toContainText("since FY2026 plan");
  await page.getByTestId("heatmap-cell").first().click();
  await expect(page.getByTestId("cell-popover")).toContainText("Budget in FY2026 plan");
});

/** HO-013: the margins are the API's; arrow keys move between cells; a phone gets a list. */
test("overview: heatmap margins, keyboard, and the phone list", async ({ page }) => {
  await as(page, "budgetOwner");
  const response = page.waitForResponse((r) => r.url().includes(`/workspaces/${ws()}/overview`) && r.request().method() === "GET");
  await page.goto(`/w/${ws()}`);
  const o = (await (await response).json()) as Overview;
  await ready(page);
  const h = o.heatmap;
  const firstRow = h.rows[0] ?? "";
  const rowTotal = h.rowTotals.find((m) => m.code === firstRow);
  const row = page.getByTestId("heatmap-row").and(page.locator(`[data-code="${firstRow}"]`));
  await expect(row.getByTestId("heatmap-row-total")).toContainText(pct(rowTotal?.spend_to_date_pct));
  await expect(row.getByTestId("heatmap-row-total")).toContainText(pace(rowTotal?.pace_index));
  const colTotal = h.colTotals.find((m) => m.code === h.cols[0]);
  await expect(page.getByTestId("heatmap-col-total").first()).toContainText(pct(colTotal?.spend_to_date_pct));
  await expect(page.getByTestId("heatmap-total")).toContainText(pct(h.total.spend_to_date_pct));
  await expect(page.getByTestId("heatmap-total")).toContainText(pace(h.total.pace_index));

  // One cell takes Tab; arrows move to the next cell with budgets; Enter opens it.
  const cells = page.getByTestId("heatmap-cell");
  await cells.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(":focus")).toHaveAttribute("aria-label", new RegExp(`^${h.labels.rows[firstRow] ?? firstRow}, ${h.labels.cols[h.cols[1] ?? ""] ?? ""}`));
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(":focus")).toHaveAttribute("aria-label", new RegExp(`^${h.labels.rows[h.rows[1] ?? ""] ?? ""}, `));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("cell-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cell-popover")).toHaveCount(0);

  // The sort is the server's: by pace, the rows come back in the order of their pace.
  await page.getByTestId("heatmap-sort").selectOption("pace");
  await expect(page).toHaveURL(/sort=(%22)?pace/);
  await ready(page);
  const paces = await page.getByTestId("heatmap-row-total").evaluateAll((els) => els.map((e) => Number(/Pace ([\d.]+)/.exec(e.textContent ?? "")?.[1] ?? "0")));
  expect(paces).toEqual([...paces].sort((a, b) => b - a));
  await page.getByTestId("heatmap-sort").selectOption("budget");
  await ready(page);

  // A phone: one column at a time, as a list with pace bars; no sideways scroll.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId("heatmap")).toBeHidden();
  await expect(page.getByTestId("heatmap-phone")).toBeVisible();
  await expect(page.getByTestId("heatmap-phone-row").first()).toContainText(h.labels.rows[firstRow] ?? firstRow);
  await page.getByTestId("heatmap-phone-col").selectOption(h.cols[0] ?? "");
  await expect(page.getByTestId("heatmap-phone-row").first()).toContainText(/\d+%/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: test.info().outputPath("overview-375.png"), fullPage: true });
});

/** HO-014: needs attention by money at stake; a rule opens Alerts filtered; the queue matches the inbox. */
test("overview: needs attention, alerts by rule and the approval queue", async ({ page }) => {
  await open(page, "budgetOwner");
  const o = await api<Overview>("budgetOwner", "GET", `/workspaces/${ws()}/overview`);
  // The server ranks: the largest money at stake first, and the page shows its order.
  const money = o.attention.all.map((i) => Math.abs(Number(i.money)));
  expect(money).toEqual([...money].sort((a, b) => b - a));
  await expect(page.getByTestId("attention-row").first()).toContainText(o.attention.all[0]?.name ?? "—");
  await page.getByTestId("attention-over").click();
  if (o.attention.over.length) {
    await expect(page.getByTestId("attention-row").first()).toHaveAttribute("data-category", "over");
    await expect(page.getByTestId("attention-row").first()).toContainText(o.attention.over[0]?.name ?? "—");
  }
  await page.getByTestId("attention-see-all").click();
  await expect(page).toHaveURL(/\/budgets\?.*filter=/);
  // Budgets may add its own history entry, so back again by URL rather than history.
  await page.goto(`/w/${ws()}`);
  await ready(page);

  // A rule opens Alerts, only that rule's open alerts.
  await page.getByTestId("alerts-rule").first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/alerts\\?.*rule=(%22)?${o.alerts.byRule[0]?.ruleId ?? ""}`));
  await expect(page.getByTestId("alerts-only-rule")).toBeVisible();
  await page.goto(`/w/${ws()}`);
  await ready(page);

  // The queue counts what the inbox lists for the same person.
  const inbox = await api<{ rows: unknown[] }>("budgetOwner", "GET", "/approvals?limit=200");
  await expect(page.getByTestId("overview-approvals")).toBeVisible();
  if (o.queue.waiting > 0) await expect(page.getByTestId("queue-waiting")).toContainText(String(inbox.rows.length));
  else await expect(page.getByTestId("overview-approvals")).toContainText("Nothing waits for approval.");
  expect(o.queue.waiting).toBe(inbox.rows.length);
});

/** Product feedback: edit budgets from the Overview, one at a time or all of a cell by a percentage. */
test("overview: edit a cell's budgets without leaving the page", async ({ page }) => {
  await open(page, "planner");
  await page.getByTestId("heatmap-row").and(page.locator('[data-code="MX"]')).getByTestId("heatmap-cell").first().click();
  await expect(page.getByTestId("cell-popover")).toContainText("Mexico ×");
  await page.getByTestId("cell-edit").click();
  await expect(page.getByTestId("cell-popover")).toHaveCount(0);
  const editor = page.getByTestId("cell-editor");
  await expect(editor.getByTestId("cell-editor-row").first()).toBeVisible();
  await expect(editor.getByTestId("cell-editor-summary")).toContainText("spent");

  // All of the cell by a percentage: the bulk preview, nothing written until Commit.
  await editor.getByTestId("cell-change").fill("10");
  await editor.getByTestId("cell-change-preview").click();
  const dialog = page.getByTestId("paste-dialog");
  await expect(dialog).toContainText("Change by 10%");
  await expect(dialog.getByTestId("paste-row").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // One budget: a new amount becomes a draft, then Send for approval, as in Budgets.
  const row = editor.getByTestId("cell-editor-row").first();
  await row.getByTestId("cell-editor-amount").fill("12345");
  await row.getByTestId("cell-editor-save").click();
  await expect(row.getByRole("button", { name: /Send for approval/ })).toBeVisible();

  await editor.getByTestId("cell-editor-close").click();
  await expect(editor).toHaveCount(0);
});

/** HO-015: what each person sees, and in what order, kept on the server and back after a reload. */
test("overview: hide, show and reorder, kept after a reload", async ({ page }) => {
  await dropLayout("finance1");
  await open(page, "finance1");
  await expect(page.getByTestId("heatmap")).toBeVisible();

  await page.getByTestId("overview-customise").click();
  await page.getByTestId("customise-heatmap").uncheck();
  await page.getByTestId("customise-headline.remaining").uncheck();
  await page.getByTestId("customise-up-queue").click(); // the queue above the KPI table
  await expect(page.getByTestId("heatmap")).toHaveCount(0);
  await expect(page.getByTestId("tile-remaining")).toHaveCount(0);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,queue,kpi,data");
  await expect(page.getByTestId("overview-customise")).toContainText("2 hidden");
  // The layout saves in the background; reload once it is on the server.
  await expect(page.getByTestId("overview-customise")).toHaveAttribute("data-saving", "false");

  await page.reload();
  await ready(page);
  await expect(page.getByTestId("overview-freshness")).toBeVisible();
  await expect(page.getByTestId("heatmap")).toHaveCount(0);
  await expect(page.getByTestId("tile-remaining")).toHaveCount(0);
  await expect(page.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,queue,kpi,data");

  // Back to the default: the private layout goes.
  await page.getByTestId("overview-customise").click();
  await page.getByTestId("customise-reset").click();
  await expect(page.getByTestId("heatmap")).toBeVisible();
  await expect(page.getByTestId("tile-remaining")).toBeVisible();
  await expect(page.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,kpi,queue,data");
  await expect(page.getByTestId("overview-customise")).toHaveAttribute("data-saving", "false");
});

/** HO-015: an admin sets the workspace default; someone without a layout of their own sees it. */
test("overview: an admin's default is what everyone else starts from", async ({ page, browser }) => {
  await dropLayout("orgAdmin");
  await dropLayout("finance2");
  await open(page, "orgAdmin");
  await page.getByTestId("overview-customise").click();
  // Only an order change: the other specs still find every block.
  await page.getByTestId("customise-up-data").click();
  await expect(page.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,kpi,data,queue");
  await expect(page.getByTestId("overview-customise")).toHaveAttribute("data-saving", "false");
  await page.getByTestId("customise-share").click();
  await expect(page.getByText("This is now the workspace default.")).toBeVisible();
  try {
    const other = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(other, "finance2");
    await expect(other.getByTestId("overview")).toHaveAttribute("data-order", "headline,heatmap,attention,alerts,kpi,data,queue");
    // Not theirs to change: no "Set as the workspace default" for finance.
    await other.getByTestId("overview-customise").click();
    await expect(other.getByTestId("customise-share")).toHaveCount(0);
    await other.close();
  } finally {
    // Leave the workspace as the other specs expect it: no shared default, no private layout.
    const views = await api<Array<{ id: string; name: string; visibility: string }>>("orgAdmin", "GET", `/workspaces/${ws()}/saved-views?screen=overview`);
    for (const v of views.filter((x) => x.visibility === "workspace" && x.name === "Overview default")) await api("orgAdmin", "DELETE", `/saved-views/${v.id}`);
    await dropLayout("orgAdmin");
  }
});
