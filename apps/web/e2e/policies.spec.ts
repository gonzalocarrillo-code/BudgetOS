import { LIVE_LEAVES } from "@budget/domain";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * Product feedback 6 (ADR-040): true rules on who can set budgets without approval. An admin adds
 * "Budget owners set budgets directly" on the Approval policies page; a budget owner's draft then
 * says "Apply now" and is set at once, while a planner's still goes for approval.
 */

test.use({ viewport: { width: 1440, height: 900 } });
const FY = { kind: "relative", preset: "current_year" };
const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
/** A leaf the persona can see with no open draft, and a new draft on it (+20 %, past the minor-change policy). */
async function draftFor(token: string) {
  const ws = state().workspaceId;
  const found = await api(token, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: FY, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["budget"], sort: [{ key: "name", dir: "desc" }], limit: 40 });
  for (const r of found.body["rows"] as Array<{ envelopeId: string; measures: { budget: string } }>) {
    const env = await api(token, "GET", `/envelopes/${r.envelopeId}`);
    if (env.body["draft"] !== null || env.body["currentVersionId"] === null) continue;
    const d = await api(token, "PATCH", `/envelopes/${r.envelopeId}/draft`, { amount: (Number(r.measures.budget) * 1.2).toFixed(2), basedOnVersionId: env.body["currentVersionId"] });
    if (d.status === 200) return r.envelopeId;
  }
  throw new Error("no leaf to draft on");
}

test("an admin lets budget owners set budgets without approval; their draft applies at once, a planner's does not", async ({ page }) => {
  const ws = state().workspaceId;
  await signIn(page, "admin");
  await page.goto(`/w/${ws}/admin/policies`);
  await expect(page.getByTestId("policy").first()).toBeVisible();
  await page.getByTestId("policy-new").click();
  const editor = page.getByTestId("policy-editor");
  await editor.getByTestId("policy-name").fill("Budget owners set budgets directly");
  await editor.getByTestId("policy-priority").fill("0");
  await editor.getByTestId("policy-entity").selectOption("envelope_version");
  await editor.getByTestId("policy-role-BUDGET_OWNER").check();
  await editor.getByTestId("policy-direct").click();
  await editor.getByTestId("policy-save").click();
  await expect(editor).toHaveCount(0);
  const first = page.getByTestId("policy").first();
  await expect(first).toHaveAttribute("data-name", "Budget owners set budgets directly");
  await expect(first.getByTestId("policy-then")).toContainText("Set at once");

  try {
    // A budget owner's draft: "Apply now", set at once.
    const owner = await tokenFor("budgetOwner");
    const mine = await draftFor(owner);
    const ownerPage = await page.context().newPage();
    await ownerPage.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), owner);
    await ownerPage.goto(`/w/${ws}/budgets?period=${encodeURIComponent(JSON.stringify(FY))}&select=${mine}`);
    const send = ownerPage.getByTestId("approval-send");
    await expect(send).toHaveAttribute("data-direct", "true");
    await expect(send).toHaveText(/Apply now/);
    await expect(ownerPage.getByTestId("approval-policy")).toContainText("Budget owners set budgets directly");
    await send.click();
    await expect(ownerPage.getByTestId("approval-state")).toHaveAttribute("data-state", "approved");
    expect((await api(owner, "GET", `/envelopes/${mine}`)).body["draft"]).toBeNull();

    // A planner's draft still goes for approval.
    const planner = await tokenFor("planner");
    const theirs = await draftFor(planner);
    const plannerPage = await page.context().newPage();
    await plannerPage.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), planner);
    await plannerPage.goto(`/w/${ws}/budgets?period=${encodeURIComponent(JSON.stringify(FY))}&select=${theirs}`);
    await expect(plannerPage.getByTestId("approval-send")).toHaveAttribute("data-direct", "false");
    await expect(plannerPage.getByTestId("approval-send")).toHaveText(/Send for approval/);
  } finally {
    // Leave the workspace as the other specs expect it: the policy off.
    const admin = await tokenFor("admin");
    const policies = (await api(admin, "GET", `/workspaces/${ws}/policies`)).body as unknown as Array<{ id: string; name: string; version: number }>;
    const p = policies.find((x) => x.name === "Budget owners set budgets directly");
    if (p) await api(admin, "PATCH", `/policies/${p.id}`, { version: p.version, isActive: false });
  }
});
