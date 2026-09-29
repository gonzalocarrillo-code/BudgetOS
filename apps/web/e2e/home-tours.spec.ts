import { DEFAULT_TOURS } from "@budget/db";
import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * T-040 (spec §27, §22): each role's tour runs end-to-end — launched from Help, every step
 * highlights its [data-tour] element (moving to the step's page when it has one), Done records the
 * completion; Home shows what is waiting first; a workspace from the template is usable in under
 * 60 s and its demo data is removed in one click.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function signIn(page: Page, persona: string): Promise<string> {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
}
const api = async (token: string, method: string, path: string, ws = state().workspaceId) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": ws } });
  return (await res.json()) as unknown;
};

/** Help → the role's tour → every step's element highlighted in order → Done. */
async function runTour(page: Page, role: string) {
  const tour = DEFAULT_TOURS.find((x) => x.role === role);
  if (!tour) throw new Error(`no ${role} tour`);
  await page.getByTestId("help-menu").click();
  await page.getByTestId("tour-start").and(page.locator(`[data-role="${role}"]`)).click();
  for (const [i, step] of tour.steps.entries()) {
    const popover = page.locator(".driver-popover");
    await expect(popover.locator(".driver-popover-title")).toHaveText(step.title);
    if (step.path) await expect(page).toHaveURL(new RegExp(`/w/[^/]+${step.path.replace(/\//g, "\\/")}(\\?|$)`));
    await expect(page.locator(`${step.element}.driver-active-element`)).toBeVisible();
    await popover.locator(".driver-popover-next-btn").click();
    if (i === tour.steps.length - 1) await expect(popover).toHaveCount(0);
  }
}

for (const [persona, role] of [["planner", "planner"], ["approver", "approver"], ["finance1", "finance"], ["orgAdmin", "data_admin"]] as const) {
  test(`tour: the ${role} tour runs end-to-end and records completion`, async ({ page }) => {
    const token = await signIn(page, persona);
    const ws = state().workspaceId;
    await page.goto(`/w/${ws}/home`);
    await expect(page.getByTestId("help-menu")).toBeVisible();
    await runTour(page, role);
    await expect
      .poll(async () => ((await api(token, "GET", `/tours?all=true&role=${role}`)) as Array<{ completed: boolean }>)[0]?.completed)
      .toBe(true);
  });
}

test("home: waiting on you first, then pacing per budget; each block opens its screen", async ({ page }) => {
  await signIn(page, "budgetOwner");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/home`);
  await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute("data-status", "active");
  const blocks = page.locator("[data-tour='home-waiting'], [data-tour='home-pacing']");
  await expect(blocks.first()).toHaveAttribute("data-tour", "home-waiting");
  await expect(page.getByTestId("home-scope").first()).toBeVisible();
  await expect(page.getByTestId("home-scope-spent").first()).toHaveText(/^\d+%$/);
  // HO-006: a strip opens its top-level budget in Budgets.
  await page.getByTestId("home-scope").first().click();
  await expect(page).toHaveURL(/\/budgets\?.*select=/);
});

test("templates: a workspace from the template is usable in under 60 s; its demo data goes in one click", async ({ page }) => {
  await signIn(page, "orgAdmin");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/admin/templates`);
  await expect(page.getByTestId("template-card").first()).toBeVisible();
  await expect(page.getByTestId("workspace-create-submit")).toBeDisabled();
  await page.getByTestId("workspace-name").fill(`E2E Agency ${Date.now()}`);
  const started = Date.now();
  await page.getByTestId("workspace-create-submit").click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/home$/, { timeout: 60_000 });
  expect(page.url()).not.toContain(ws);
  await expect(page.getByTestId("home-demo")).toBeVisible();
  await expect(page.getByTestId("home-scope").first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(60_000);

  await page.getByRole("link", { name: "Manage demo data" }).click();
  await expect(page.getByTestId("demo-count")).toContainText("9 budgets");
  await page.getByTestId("demo-purge").click();
  await page.getByTestId("demo-purge-confirm").click();
  await expect(page.getByTestId("demo-count")).toHaveText("This workspace has no demo data.");
  await expect(page.getByTestId("demo-purge")).toBeDisabled();
});

/** Product feedback 2026-09-28: a blank workspace says "Add your first budgets", and that works end to end. */
test("home: a blank workspace starts with its first budgets; the greeting is the person's name", async ({ page }) => {
  await signIn(page, "orgAdmin");
  await page.goto(`/w/${state().workspaceId}/admin/templates`);
  await expect(page.getByTestId("template-card").first()).toBeVisible();
  await page.getByTestId("workspace-name").fill(`E2E Blank ${Date.now()}`);
  await page.getByTestId("workspace-demo").uncheck();
  await page.getByTestId("workspace-create-submit").click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/home$/, { timeout: 60_000 });

  await expect(page.getByTestId("page-title")).toHaveText(/^Good (morning|afternoon|evening), Golden$/);
  await expect(page.getByTestId("home-first-budgets")).toHaveText("Add your first budgets");
  await expect(page.getByTestId("home-step")).toHaveCount(5);
  await expect(page.getByTestId("home-step").first()).toHaveAttribute("data-done", "false");

  await page.getByTestId("home-new-budget").click();
  const dialog = page.getByTestId("new-budget-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-budget-name").fill("FY media");
  await dialog.getByTestId("new-budget-amount").fill("250000");
  await dialog.getByTestId("new-budget-create").click();
  await expect(dialog).toHaveCount(0);
  const drawer = page.getByTestId("envelope-drawer");
  await expect(drawer).toContainText("FY media");
  await expect(drawer.getByTestId("approval-state")).toHaveAttribute("data-state", "draft");

  // Home now shows the year's numbers instead of the first steps.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByTestId("home-getting-started")).toHaveCount(0);
});

test("profile: a person renames themselves and Home greets them by it", async ({ page }) => {
  await signIn(page, "finance2");
  await page.goto(`/w/${state().workspaceId}/home`);
  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-name").fill("Priya Raman");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("user-name")).toHaveText("Priya Raman");
  await expect(page.getByTestId("page-title")).toHaveText(/^Good (morning|afternoon|evening), Priya$/);
});

/**
 * UX-001 (product feedback round 6): a tour never starts by itself, so a person with an unfinished
 * tour lands on the page they opened. Home invites them instead; "Not now" records a skip.
 */
test("tours: nothing starts by itself; Home invites, Not now skips it for this version", async ({ page }) => {
  const admin = await tokenFor("orgAdmin");
  const approverTour = ((await api(admin, "GET", "/tours?all=true&role=approver")) as Array<{ id: string; steps: unknown[] }>)[0];
  // A new version (same steps): the approver has not seen it yet.
  await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/tours/${approverTour?.id ?? ""}`, { method: "PATCH", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json", "x-workspace-id": state().workspaceId }, body: JSON.stringify({ steps: approverTour?.steps }) });
  await signIn(page, "approver");
  const ws = state().workspaceId;
  await page.goto(`/w/${ws}/targets`);
  await expect(page.getByTestId("page-title")).toHaveText("Targets");
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(new RegExp(`/w/${ws}/targets$`));
  await expect(page.locator(".driver-popover")).toHaveCount(0);

  await page.goto(`/w/${ws}/home`);
  const invite = page.getByTestId("tour-invite");
  await expect(invite).toHaveAttribute("data-role", "approver");
  await expect(page).toHaveURL(new RegExp(`/w/${ws}/home$`));
  await invite.getByTestId("tour-invite-skip").click();
  await expect(invite).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("page-title")).toBeVisible();
  await expect(page.getByTestId("tour-invite")).toHaveCount(0);
  await page.getByTestId("help-menu").click();
  await expect(page.getByTestId("tour-start").and(page.locator('[data-role="approver"]'))).toContainText("Skipped");
});
