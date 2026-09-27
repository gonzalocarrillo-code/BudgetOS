import { GOLDEN_ASSERTIONS, GOLDEN_EXPERIMENT } from "@budget/db";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-038 (spec §25): the Experiments screens. The seeded experiment's read-out shows the planner's
 * weighted CPA for test and control side by side; concluding needs a decision of 20+ characters and
 * posts it on every linked budget. A fresh experiment is concluded so later specs keep the seeded one.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function signIn(page: Page, persona = "planner"): Promise<string> {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
}
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const scope = (dims: Record<string, string>) => ({ logic: "and", children: Object.entries(dims).map(([key, value]) => ({ field: { kind: "dimension", key }, op: "eq", value })) });

test("experiments: the seeded read-out, test vs control; conclude requires a decision and posts it on the linked budgets", async ({ page }) => {
  const token = await signIn(page);
  const ws = state().workspaceId;

  await page.goto(`/w/${ws}/experiments?status=%22RUNNING%22`);
  await expect(page.getByTestId("status-RUNNING")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("experiment-link").filter({ hasText: GOLDEN_EXPERIMENT.name }).click();
  await expect(page.getByTestId("page-title")).toHaveText(GOLDEN_EXPERIMENT.name);
  await expect(page.getByTestId("readout-test-metric")).toHaveText(Number(GOLDEN_ASSERTIONS.experiments.test.cpa).toFixed(2));
  await expect(page.getByTestId("readout-control-metric")).toHaveText(Number(GOLDEN_ASSERTIONS.experiments.control.cpa).toFixed(2));
  await expect(page.getByTestId("criterion-badge")).toHaveAttribute("data-met", "false"); // TikTok's CPA is higher
  await expect(page.getByTestId("linked-test")).toHaveAttribute("data-rows", "1");
  await expect(page.getByTestId("linked-control")).toHaveAttribute("data-rows", "1");

  // A fresh experiment: created, linked and started through the API; concluded in the UI.
  const created = await api(token, "POST", `/workspaces/${ws}/experiments`, { name: `E2E objective test ${Date.now()}`, hypothesis: "Consideration converts cheaper than awareness in Brazil.", kind: "OBJECTIVE_TEST", testFilter: scope({ country: "BR", objective: "consideration" }), controlFilter: scope({ country: "BR", objective: "awareness" }), primaryMetric: "cpa", criterion: { comparator: "lte", vs: "control" }, startDate: "2026-02-01", endDate: "2026-05-31" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body["id"]);
  await page.goto(`/w/${ws}/experiments/${id}`);
  await expect(page.getByTestId("experiment-conclude")).toBeDisabled(); // planned, nothing linked
  for (const role of ["TEST", "CONTROL"] as const) {
    await page.getByTestId("link-role").selectOption(role);
    const envelope = page.getByTestId("link-envelope");
    await expect(envelope.locator("option").nth(1)).toBeAttached();
    await envelope.selectOption({ index: 1 });
    await page.getByTestId("link-submit").click();
    await expect(page.getByTestId(`linked-${role.toLowerCase()}`)).toHaveAttribute("data-rows", "1");
  }
  await page.getByTestId("experiment-start").click();
  await expect(page.getByTestId("experiment-status")).toHaveAttribute("data-status", "RUNNING");

  await page.getByTestId("experiment-conclude").click();
  const dialog = page.getByTestId("conclude-dialog");
  await dialog.getByTestId("conclude-decision").fill("Too short");
  await expect(dialog.getByTestId("conclude-submit")).toBeDisabled();
  const decision = "Consideration wins on CPA; move 15% of awareness into it next quarter.";
  await dialog.getByTestId("conclude-decision").fill(decision);
  await dialog.getByTestId("conclude-submit").click();
  await expect(page.getByTestId("experiment-status")).toHaveAttribute("data-status", "CONCLUDED");
  await expect(page.getByTestId("experiment-decision")).toHaveText(decision);
  await expect(page.getByTestId("experiment-conclude")).toHaveCount(0);

  // The decision is a comment on each linked budget (its decision timeline).
  const detail = await api(token, "GET", `/experiments/${id}`);
  const envelopes = (detail.body["experiment"] as { envelopes: Array<{ envelopeId: string }> }).envelopes;
  expect(envelopes).toHaveLength(2);
  for (const e of envelopes) expect(JSON.stringify((await api(token, "GET", `/envelopes/${e.envelopeId}/timeline`)).body)).toContain(decision);
});

test("experiments: the create form explains what is missing and opens the new experiment", async ({ page }) => {
  await signIn(page);
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/experiments`);
  await page.getByTestId("experiment-new").click();
  const dialog = page.getByTestId("experiment-create");
  await expect(dialog.getByTestId("experiment-create-submit")).toBeDisabled();
  await dialog.getByTestId("experiment-name").fill("E2E geo holdout");
  await dialog.getByTestId("experiment-hypothesis").fill("Pausing MX awareness does not move conversions.");
  await dialog.getByTestId("experiment-kind").selectOption("GEO_HOLDOUT");
  await dialog.getByTestId("experiment-criterion").selectOption("absolute:gte");
  await dialog.getByTestId("experiment-value").fill("10");
  await dialog.getByTestId("experiment-test-scope").getByRole("button", { name: /add filter/i }).click();
  await dialog.getByTestId("experiment-test-scope").locator("select").first().selectOption("country");
  await dialog.getByTestId("experiment-test-scope").locator("select[multiple]").selectOption("MX");
  await dialog.getByTestId("experiment-test-scope").getByRole("button", { name: /apply/i }).click();
  await dialog.getByTestId("experiment-create-submit").click();
  await expect(page).toHaveURL(/\/experiments\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("page-title")).toHaveText("E2E geo holdout");
  await expect(page.getByTestId("experiment-status")).toHaveAttribute("data-status", "PLANNED");
  await expect(page.getByTestId("readout-control")).toContainText(/judged against the target/);
});
