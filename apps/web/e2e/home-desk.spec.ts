import { LIVE_LEAVES } from "@budget/domain";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS, dbEnv } from "./env.js";
import { as } from "./ops.js";

/**
 * HO-006 and HO-007 (docs/HOME_OVERVIEW_PLAN.md §3.1): Home is each person's desk. The pulse first,
 * then what waits on them, their budgets, where they left off and what they sent. Each item opens
 * its screen filtered, every action takes the keyboard, and an approval is decided in a side sheet.
 * The spec makes its own requests (a bulk change and one budget), so it does not depend on the golden
 * bulk still waiting: the approvals spec decides that one.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
const api = async (persona: string, method: string, path: string, body?: unknown): Promise<Json> => {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(persona)}`, "x-workspace-id": state().workspaceId, ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = (await res.json()) as Json;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const dim = (key: string, value: string) => ({ field: { kind: "dimension", key }, op: "eq", value });
const open = async (page: Page, persona: string) => {
  await as(page, persona);
  await page.goto(`/w/${state().workspaceId}/home`);
  await expect(page.getByTestId("home-desk")).toBeVisible();
};
const BULK = "HO desk e2e: LATAM tiktok awareness +10%";
let single: { requestId: string; name: string };

test.beforeAll(async () => {
  const ws = state().workspaceId;
  // A bulk change the planner sends: LATAM × TikTok × awareness, 4 countries × 2 audiences.
  const selection = { filter: { logic: "and", children: [...LIVE_LEAVES, dim("region", "LATAM"), dim("platform", "tiktok"), dim("objective", "awareness")] } };
  const preview = await api("planner", "POST", "/envelopes/bulk", { workspaceId: ws, selection, operation: { op: "pct", pct: 10 }, rationale: BULK });
  await api("planner", "POST", `/envelopes/bulk/${String(preview["previewId"])}/commit`);
  // And one budget, half as much again: a request whose first step is a budget owner's.
  const q = await api("planner", "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: [...LIVE_LEAVES, dim("country", "CO"), dim("platform", "google_ads"), dim("objective", "conversion"), dim("audience", "retargeting")] }, measures: ["budget"], limit: 1 });
  const [leaf] = q["rows"] as Array<{ envelopeId: string; versionId: string; path: string[]; measures: { budget: string } }>;
  if (!leaf) throw new Error("no CO google_ads conversion retargeting leaf");
  const draft = await api("planner", "PATCH", `/envelopes/${leaf.envelopeId}/draft`, { amount: (Number(leaf.measures.budget) * 1.5).toFixed(2), basedOnVersionId: leaf.versionId });
  const sent = await api("planner", "POST", `/envelopes/${leaf.envelopeId}/submit`, { versionId: draft["id"] });
  if (sent["autoApproved"] !== false) throw new Error(`expected a request, got ${JSON.stringify(sent)}`);
  single = { requestId: String(sent["requestId"]), name: leaf.path.at(-1) ?? "" };
});

test("home: the pulse, then what waits, then budgets, recents and what was sent", async ({ page }) => {
  await open(page, "budgetOwner");
  const order = await page.locator("[data-tour='home-pulse'], [data-tour='home-waiting'], [data-tour='home-pacing'], [data-tour='home-recents'], [data-tour='home-sent']").evaluateAll((els) => els.map((e) => e.getAttribute("data-tour")));
  expect(order).toEqual(["home-pulse", "home-waiting", "home-pacing", "home-recents", "home-sent"]);
  // The pulse is the Overview's headline in one line, and a way there.
  await expect(page.getByTestId("home-pulse")).toContainText("budget");
  await expect(page.getByTestId("home-pulse-alerts")).toContainText(/\d+ open alerts/);
  await expect(page.getByTestId("home-as-of")).toContainText("Actuals through Aug 31, 2026");
  await page.getByTestId("home-pulse-open").click();
  await expect(page).toHaveURL(new RegExp(`/w/${state().workspaceId}$`));
  await page.screenshot({ path: test.info().outputPath("home-budget-owner-1440.png"), fullPage: true });
});

test("home: the budget owner decides, and opens the alerts on their budgets by rule", async ({ page }) => {
  await open(page, "budgetOwner");
  const bulk = page.getByTestId("home-approval").filter({ hasText: BULK });
  await expect(bulk).toContainText("8 budgets");
  await expect(bulk).toContainText("+10.0%");
  await expect(bulk).toContainText("Requested by Golden planner");
  const group = page.getByTestId("home-alert-group").first();
  await expect(group).toContainText(/open alerts on (EMEA|LATAM)/);
  await group.getByTestId("home-alert-rule").first().click();
  await expect(page).toHaveURL(/\/alerts\?.*rule=.*under=|\/alerts\?.*under=.*rule=/);
  await expect(page.getByTestId("alerts-only-rule")).toBeVisible();
  await expect(page.getByTestId("alerts-only-under")).toContainText(/Under (EMEA|LATAM)/);
  await expect(page.getByTestId("alerts-table").locator("tbody tr").first()).toBeVisible();
  await page.getByTestId("alerts-only-clear").click();
  await expect(page.getByTestId("alerts-only")).toHaveCount(0);
  // "1 alert" on a budget in Home's budgets strip opens that budget's alerts (round 12).
  await page.goBack();
  await page.goBack();
  const chip = page.getByTestId("home-scope-alerts").first();
  await chip.click();
  await expect(page).toHaveURL(/\/alerts\?.*under=/);
  await expect(page.getByTestId("alerts-table").locator("tbody tr").first()).toBeVisible();
});

test("home: the planner sees what they sent waiting on others, and no data to map", async ({ page }) => {
  await open(page, "planner");
  await expect(page.getByTestId("home-sent-item").filter({ hasText: BULK })).toContainText("waiting on Budget owner");
  await expect(page.getByTestId("home-unmatched")).toHaveCount(0);
  await expect(page.getByTestId("home-recent").first()).toBeVisible();
  // A strip opens its budget in Budgets.
  await page.getByTestId("home-scope-open").first().click();
  await expect(page).toHaveURL(/\/budgets\?.*select=/);
});

test("home: an admin maps the unmatched spend from Home; every action takes the keyboard", async ({ page }) => {
  await open(page, "admin");
  const actions = page.getByTestId("home-waiting").locator("a, button");
  const n = await actions.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    await actions.nth(i).focus();
    await expect(actions.nth(i)).toBeFocused();
  }
  await page.getByTestId("home-unmatched").getByRole("link").click();
  await expect(page).toHaveURL(/\/sources/);
});

test("home on a phone: one column, nothing wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "budgetOwner");
  const overflow = await page.getByTestId("main-scroll").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("home-approval").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("home-budget-owner-375.png"), fullPage: true });
});

test("home: an approval is decided in a side sheet; it leaves the list, audited once (HO-007)", async ({ page }) => {
  await open(page, "budgetOwner");
  const item = page.getByTestId("home-approval").filter({ hasText: single.name });
  await expect(item).toBeVisible();
  await item.getByTestId("home-decide").click();
  const sheet = page.getByTestId("decide-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("diff-table")).toContainText(single.name);
  await expect(sheet.getByTestId("chain")).toBeVisible();
  await expect(sheet.getByTestId("decide-sheet-open")).toHaveAttribute("href", new RegExp(`/approvals/${single.requestId}$`));
  await sheet.getByTestId("decide-approve").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("home-approval").filter({ hasText: single.name })).toHaveCount(0);

  // The request page's command: one decision by this account, audited, with its outbox event.
  const detail = await api("budgetOwner", "GET", `/approvals/${single.requestId}`);
  expect((detail["decisions"] as Array<{ decision: string; stepIndex: number }>).map((d) => [d.decision, d.stepIndex])).toEqual([["approve", 0]]);
  const db = new PrismaClient({ datasources: { db: { url: dbEnv()["DATABASE_URL"] ?? "" } } });
  try {
    const [audits] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_type = 'approval_request' AND entity_id = $1::uuid AND action = 'approval.approve'`, single.requestId);
    expect(Number(audits?.n)).toBe(1);
    const [events] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'approval.changed' AND payload->>'requestId' = $1 AND payload->>'action' = 'approval.approve'`, single.requestId);
    expect(Number(events?.n)).toBe(1);
  } finally {
    await db.$disconnect();
  }
});
