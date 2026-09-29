import { expect, test, type Page } from "@playwright/test";
import LZString from "lz-string";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * R9-002 done-when (ADR-060): a budget's dates are editable from the drawer and from the Budgets
 * grid's Dates column. A planner's change to an approved budget waits for approval (and a rejection
 * leaves the dates as they were); an admin's applies at once. The shared workspace is left as found.
 */

const as = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.context().clearCookies();
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
  return token;
};
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-workspace-id": state().workspaceId, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const idOf = async (token: string, name: string) => {
  const res = await api(token, "GET", `/workspaces/${state().workspaceId}/search?q=${encodeURIComponent(name)}&types=envelope&limit=20`);
  const hit = ((res.body["groups"] as Array<{ type: string; hits: Array<{ id: string; title: string }> }>).find((g) => g.type === "envelope")?.hits ?? []).find((h) => h.title === name);
  if (!hit) throw new Error(`no envelope named ${name}`);
  return hit.id;
};
type Env = { startDate: string; endDate: string; currentVersionId: string | null; draftVersionId: string | null; openRequest: { id: string } | null };
const envOf = async (token: string, id: string) => (await api(token, "GET", `/envelopes/${id}`)).body as unknown as Env;
/** A month off the end: 31 Dec becomes 30 Nov. */
const monthEarlier = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
const enc = (v: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(v));

test.describe.configure({ mode: "serial" });
// The grid's Dates column sits after the five measures: wide enough that it is on screen.
test.use({ viewport: { width: 1680, height: 900 } });
test.describe("change a budget's dates (R9-002)", () => {
  const name = "FR google_ads consideration retargeting";

  test("from the drawer, a planner's new dates wait for approval; rejected, nothing changes", async ({ page }) => {
    const token = await as(page, "planner");
    const id = await idOf(token, name);
    const before = await envOf(token, id);
    await page.goto(`/w/${state().workspaceId}/budgets?select=%22${id}%22`);
    await expect(page.getByTestId("drawer-dates")).toContainText(`${before.startDate} – ${before.endDate}`);
    await page.getByTestId("drawer-edit-dates").click();
    const dialog = page.getByTestId("dates-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("dates-commit")).toBeDisabled();
    await page.getByTestId("dates-end").fill(monthEarlier(before.endDate));
    await expect(page.getByTestId("dates-preview")).toHaveAttribute("data-needs-approval", "true");
    await expect(page.getByTestId("dates-line").first()).toContainText(monthEarlier(before.endDate));
    await page.getByTestId("dates-reason").fill("Campaign ends a month early");
    await page.getByTestId("dates-commit").click();
    await expect(page.getByTestId("drawer-dates-notice")).toContainText("Sent for approval");
    await expect(page.getByTestId("drawer-pending-dates")).toBeVisible();
    // Nothing applies while it waits.
    const waiting = await envOf(token, id);
    expect(waiting.endDate).toBe(before.endDate);

    const requestId = waiting.openRequest?.id as string;
    expect(requestId).toBeTruthy();
    const rejected = await api(await tokenFor("budgetOwner"), "POST", `/approvals/${requestId}/decisions`, { decision: "reject", comment: "keep it running" });
    expect(rejected.status).toBe(201);
    const after = await envOf(token, id);
    expect([after.startDate, after.endDate, after.currentVersionId]).toEqual([before.startDate, before.endDate, before.currentVersionId]);
  });

  test("from the grid's Dates column, an admin's new dates apply at once", async ({ page }) => {
    const token = await as(page, "admin");
    const id = await idOf(token, name);
    const before = await envOf(token, id);
    const filter = { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "eq", value: name }] };
    await page.goto(`/w/${state().workspaceId}/budgets?view=pivot&filter=${enc(filter)}`);
    await expect.poll(() => page.getByTestId("explorer-grid").getAttribute("data-rows")).toBe("1");
    const box = await page.getByTestId("explorer-grid").locator("canvas").first().boundingBox();
    if (!box) throw new Error("grid canvas not rendered");
    // Name 340, five measures (4 × 150 + 110), then Dates.
    await page.mouse.click(box.x + 340 + 4 * 150 + 110 + 100, box.y + 40 + 18);
    await expect(page.getByTestId("dates-dialog")).toBeVisible();
    const endDate = monthEarlier(before.endDate);
    await page.getByTestId("dates-end").fill(endDate);
    await expect(page.getByTestId("dates-preview")).toHaveAttribute("data-needs-approval", "true");
    await page.getByTestId("dates-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("Dates changed");
    expect((await envOf(token, id)).endDate).toBe(endDate);

    // Leave the shared workspace as it was.
    const now = await envOf(token, id);
    const back = await api(token, "POST", `/envelopes/${id}/dates`, { startDate: before.startDate, endDate: before.endDate, basedOnVersionId: now.draftVersionId ?? now.currentVersionId });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect((await envOf(token, id)).endDate).toBe(before.endDate);
  });
});
