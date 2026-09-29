import { expect, test, type Page } from "@playwright/test";
import LZString from "lz-string";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";

/**
 * R9-004 done-when (plan epic 2.5, ADR-061): a budget's timeline bar resizes (and moves) to change
 * its dates. The drop opens Change dates with the dropped dates; cancelling puts the bar back and
 * changes nothing; committing (an admin's change applies at once, ADR-048) redraws the bar at its new
 * dates. A read-only role's bars and a past as-of do not move. The shared workspace is left as found.
 */

test.use({ viewport: { width: 1600, height: 900 } });
test.describe.configure({ mode: "serial" });

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
type Env = { startDate: string; endDate: string; currentVersionId: string | null; draftVersionId: string | null };
const envOf = async (token: string, id: string) => (await api(token, "GET", `/envelopes/${id}`)).body as unknown as Env;
const enc = (v: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(v));

const name = "FR google_ads consideration prospecting";
const timelineOf = (asOf?: string) => {
  const filter = { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "eq", value: name }] };
  // FY zoom: the whole fiscal year fits on screen, so both ends of a bar can be grabbed.
  return `/w/${state().workspaceId}/budgets?view=timeline&zoom=fy&filter=${enc(filter)}${asOf ? `&asOf=${encodeURIComponent(JSON.stringify(asOf))}` : ""}`;
};
/** SVAR's bar box around our bar template for the budget. */
const barOf = (page: Page, envelopeId: string) => page.locator(".wx-bar").filter({ has: page.locator(`.bt-bar[data-bar-key$="${envelopeId}"]`) }).first();
/** Grabs one end of the bar and drags it by dx pixels, in steps so SVAR sees a drag. */
async function dragEnd(page: Page, envelopeId: string, end: "start" | "end", dx: number) {
  const box = await barOf(page, envelopeId).boundingBox();
  if (!box) throw new Error("bar not drawn");
  // SVAR resizes from the outer 40px of a wide bar; a full-year bar's very edge is on the chart's edge.
  const x = end === "end" ? box.x + box.width - 20 : box.x + 20;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(x + (dx * i) / 10, y);
  await page.mouse.up();
  return box;
}

test("resizing a bar's end proposes new dates; cancelling puts it back and changes nothing", async ({ page }) => {
  const token = await as(page, "admin");
  const id = await idOf(token, name);
  const before = await envOf(token, id);
  await page.goto(timelineOf());
  await expect(page.getByTestId("budget-timeline")).toHaveAttribute("data-readonly", "false");
  await expect(page.locator(`.bt-bar[data-bar-key$="${id}"]`)).toHaveAttribute("data-movable", "true");

  const box = await dragEnd(page, id, "end", -160);
  const dialog = page.getByTestId("dates-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("dates-start")).toHaveValue(before.startDate);
  const proposedEnd = await page.getByTestId("dates-end").inputValue();
  expect(proposedEnd < before.endDate, `${proposedEnd} before ${before.endDate}`).toBe(true);
  await expect(page.getByTestId("dates-preview")).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await barOf(page, id).boundingBox())?.width).toBeCloseTo(box.width, 0);
  expect(await envOf(token, id)).toMatchObject({ startDate: before.startDate, endDate: before.endDate });
});

test("resizing a bar's start and committing applies at once for an admin; the bar redraws", async ({ page }) => {
  const token = await as(page, "admin");
  const id = await idOf(token, name);
  const before = await envOf(token, id);
  await page.goto(timelineOf());
  const box = await dragEnd(page, id, "start", 160);
  await expect(page.getByTestId("dates-dialog")).toBeVisible();
  const proposedStart = await page.getByTestId("dates-start").inputValue();
  expect(proposedStart > before.startDate).toBe(true);
  await expect(page.getByTestId("dates-end")).toHaveValue(before.endDate);
  await page.getByTestId("dates-commit").click();
  await expect(page.getByTestId("notice-ok")).toContainText("Dates changed");
  await expect.poll(async () => (await envOf(token, id)).startDate).toBe(proposedStart);
  await expect.poll(async () => (await barOf(page, id).boundingBox())?.x ?? 0).toBeGreaterThan(box.x + 100);

  // Leave the shared workspace as it was.
  const now = await envOf(token, id);
  const back = await api(token, "POST", `/envelopes/${id}/dates`, { startDate: before.startDate, endDate: before.endDate, basedOnVersionId: now.draftVersionId ?? now.currentVersionId });
  expect(back.status, JSON.stringify(back.body)).toBe(201);
});

test("a read-only role's bars and a past as-of do not move", async ({ page }) => {
  const token = await as(page, "approver"); // reads and decides, never edits a budget
  const id = await idOf(token, name);
  await page.goto(timelineOf());
  await expect(page.getByTestId("budget-timeline")).toHaveAttribute("data-readonly", "true");
  await expect(page.locator(`.bt-bar[data-bar-key$="${id}"]`)).toHaveAttribute("data-movable", "false");
  await dragEnd(page, id, "end", -160);
  await expect(page.getByTestId("dates-dialog")).toHaveCount(0);

  await as(page, "admin");
  await page.goto(timelineOf("2026-03-31T23:59:59.999Z"));
  await expect(page.getByTestId("budget-timeline")).toHaveAttribute("data-readonly", "true");
});
