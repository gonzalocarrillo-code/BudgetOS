import { LIVE_LEAVES } from "@budget/domain";
import { expect, test, type Page } from "@playwright/test";
import { Decimal } from "decimal.js";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-037 (spec §23): the Explorer's Timeline view. The same search params as the tree; group,
 * envelope and target bars on the fiscal calendar; markers, the today line; a row opens the drawer;
 * the as-of scrubber redraws the timeline as it was, matching /query?asOf; read-only.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const FY = encodeURIComponent(JSON.stringify({ kind: "relative", preset: "current_year" }));
type Bar = { kind: string; budget?: string; envelopeId?: string };

async function signIn(page: Page, persona = "planner"): Promise<string> {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
}
async function queryTotal(token: string, asOf?: string): Promise<string> {
  const ws = state().workspaceId;
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${ws}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: ws, filter: { logic: "and", children: LIVE_LEAVES }, period: { kind: "relative", preset: "current_year" }, measures: ["budget"], limit: 1, ...(asOf ? { asOf } : {}) }),
  });
  const body = (await res.json()) as { totals: Record<string, string | null> };
  return new Decimal(body.totals["budget"] ?? 0).toFixed(2);
}
/** The workspace's default hierarchy template (the grouped timeline; Budget structure is the default view, ADR-050). */
async function defaultTemplate(token: string): Promise<string> {
  const ws = state().workspaceId;
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/workspaces/${ws}/hierarchy-templates`, { headers: { authorization: `Bearer ${token}`, "x-workspace-id": ws } });
  const list = (await res.json()) as Array<{ id: string; isDefault: boolean }>;
  return (list.find((x) => x.isDefault) ?? list[0])?.id ?? "";
}
const envelopeTotal = (bars: Bar[]) => bars.filter((b) => b.kind === "envelope").reduce((s, b) => s.plus(b.budget ?? 0), new Decimal(0)).toFixed(2);

test("timeline: bars on the fiscal calendar, targets as lanes, a row opens the drawer, as-of matches /query", async ({ page }) => {
  const token = await signIn(page);
  const ws = state().workspaceId;
  const first = page.waitForResponse((r) => r.url().includes(`/workspaces/${ws}/timeline`) && !r.url().includes("asOf="));
  await page.goto(`/w/${ws}/budgets?view=%22timeline%22&period=${FY}&templateId=${encodeURIComponent(JSON.stringify(await defaultTemplate(token)))}`);
  const now = (await (await first).json()) as { bars: Bar[] };
  const view = page.getByTestId("timeline-view");
  await expect(view).toBeVisible();
  expect(envelopeTotal(now.bars)).toBe(await queryTotal(token));
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");

  const timeline = page.getByTestId("budget-timeline");
  await expect(timeline.locator(".bt-group").first()).toBeVisible();
  await expect(timeline.locator(".bt-envelope").first()).toBeAttached();
  await expect(page.getByTestId("timeline-today")).toBeAttached();
  await expect(page.getByTestId("timeline-marker").first()).toBeAttached();
  await expect(page.locator(".wx-marker")).toHaveCount(0); // SVAR's PRO markers never render; the overlay is ours
  await expect(page.locator(".wx-timescale-viewport, .wx-scale").first()).toContainText("FY2026");

  // Target lanes: an envelope with targets is collapsed (lazy); opening it shows its lanes.
  const lazy = page.locator(".wx-row").filter({ has: page.locator(".bt-cell-envelope") }).filter({ has: page.locator(".wx-toggle-icon.wxi-menu-right") }).first();
  await lazy.locator(".wx-toggle-icon").click();
  await expect(timeline.locator(".bt-target").first()).toBeVisible();
  await expect(page.locator(".bt-cell-target").first()).toContainText(/CPA/);

  // Selecting an envelope row opens the drawer (select= in the URL).
  await page.locator(".wx-row .bt-cell-envelope").first().click();
  await expect(page).toHaveURL(/select=/);
  await expect(page.getByTestId("drawer-name")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page).not.toHaveURL(/select=/);

  // As-of scrubber: drag the handle back; the redraw equals /query?asOf.
  const handle = page.getByTestId("timeline-asof-handle");
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error("no as-of handle");
  const redraw = page.waitForResponse((r) => r.url().includes(`/workspaces/${ws}/timeline`) && r.url().includes("asOf="));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 260, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const then = (await (await redraw).json()) as { bars: Bar[]; asOf: string };
  await expect(page).toHaveURL(/asOf=/);
  await expect(page.getByTestId("as-of-banner")).toContainText(then.asOf.slice(0, 10));
  expect(envelopeTotal(then.bars)).toBe(await queryTotal(token, then.asOf));

  await page.getByTestId("as-of-now").click();
  await expect(page).not.toHaveURL(/asOf=/);

  // Zoom is in the URL; quarters label the fiscal quarters.
  await page.getByTestId("zoom-picker").selectOption("quarter");
  await expect(page).toHaveURL(/zoom=/);
  await expect(page.locator(".wx-timescale-viewport, .wx-scale").first()).toContainText("Q4");
});

/** ADR-050: under Budget structure (the default) every budget is a bar, parents included, nested by parent links. */
test("timeline: the budget structure by default, parents before their children", async ({ page }) => {
  await signIn(page);
  const ws = state().workspaceId;
  const first = page.waitForResponse((r) => r.url().includes(`/workspaces/${ws}/timeline`) && r.url().includes("structure=true"));
  await page.goto(`/w/${ws}/budgets?view=%22timeline%22&period=${FY}`);
  const bars = ((await (await first).json()) as { bars: Array<Bar & { key: string; parentKey: string | null; level: number }> }).bars.filter((b) => b.kind === "envelope");
  const levels = new Map<string, number>();
  for (const b of bars) {
    expect(b.level).toBe(b.parentKey === null ? 0 : (levels.get(b.parentKey) ?? -99) + 1);
    levels.set(b.key, b.level);
  }
  expect(bars.some((b) => b.level > 0)).toBe(true);
  await expect(page.getByTestId("template-picker")).toHaveValue("");
  await expect(page.getByTestId("budget-timeline").locator(".bt-envelope").first()).toBeAttached();
});
