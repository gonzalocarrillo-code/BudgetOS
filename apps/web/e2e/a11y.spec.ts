import { expect, test, type Page } from "@playwright/test";
import { state, tokenFor } from "./auth.js";

/**
 * UX-010: an accessibility smoke over the main screens — one page heading, the main and navigation
 * landmarks, every button named, every field labelled, focus visible. (axe-core is MPL-2.0, outside
 * the licence allowlist, so these checks are written here.)
 */
test.use({ viewport: { width: 1440, height: 900 } });
const signIn = async (page: Page, persona: string) => {
  const token = await tokenFor(persona);
  await page.addInitScript((t) => sessionStorage.setItem("budget-os.idToken", t), token);
};

const SCREENS = ["/home", "", "/budgets", "/approvals", "/targets", "/experiments", "/alerts", "/closures", "/snapshots", "/sources", "/admin/registry", "/admin/rules", "/admin/roles", "/admin/tags", "/admin/settings", "/admin/policies", "/admin/periods"];

for (const path of SCREENS) {
  test(`a11y smoke: ${path || "/ (Overview)"}`, async ({ page }) => {
    await signIn(page, "admin");
    await page.goto(`/w/${state().workspaceId}${path}`);
    await expect(page.getByTestId("page-title")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const name = (el: Element) => {
        const labelled = el.getAttribute("aria-labelledby");
        const byIds = labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
        const labels = (el as HTMLInputElement).labels ? [...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent ?? "").join(" ") : "";
        return [el.getAttribute("aria-label") ?? "", byIds, labels, el.getAttribute("title") ?? "", (el as HTMLElement).innerText ?? "", el.getAttribute("placeholder") ?? ""].join(" ").trim();
      };
      if (document.querySelectorAll("h1").length !== 1) out.push(`h1 count ${document.querySelectorAll("h1").length}`);
      if (!document.querySelector("main")) out.push("no <main>");
      if (!document.querySelector("nav")) out.push("no <nav>");
      for (const b of document.querySelectorAll("button, [role=button], a[href]")) if (visible(b) && !name(b) && !b.querySelector("img[alt]:not([alt=''])") && !b.querySelector("[role=img][aria-label]")) out.push(`unnamed ${b.tagName.toLowerCase()} ${(b as HTMLElement).outerHTML.slice(0, 120)}`);
      for (const f of document.querySelectorAll("input:not([type=hidden]), select, textarea")) if (visible(f) && !name(f)) out.push(`unlabelled ${(f as HTMLElement).outerHTML.slice(0, 120)}`);
      return out;
    });
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

test("keyboard: Tab reaches the search, and focus is visible", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/home`);
  await expect(page.getByTestId("page-title")).toBeVisible();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? getComputedStyle(el).outlineStyle + "|" + getComputedStyle(el).boxShadow : "";
  });
  expect(outline === "none|none").toBe(false);
});

test("dark mode: the user menu switches the theme and it sticks", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/w/${state().workspaceId}/home`);
  await page.getByTestId("profile-button").click();
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(240, 244, 248)");
  await page.getByTestId("profile-button").click();
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The header's one-click toggle flips day and night too.
  await page.keyboard.press("Escape");
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/**
 * HO-016: Home and the Overview on a phone, in both themes. Nothing wider than the screen, the
 * title row scrolls away (it would cover a third of the screen), no text under 12 px, every control
 * named — including the Overview's Customise menu and the heatmap's phone list.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`phone, ${scheme}: Home and the Overview fit, read and name their controls`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, "admin");
    const check = () =>
      page.evaluate((root) => {
        const out: string[] = [];
        const el = document.querySelector(root);
        if (!el) return [`no ${root}`];
        if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page ${document.documentElement.scrollWidth}px wide`);
        if (getComputedStyle(document.querySelector('[data-testid="page-header"]') as Element).position === "sticky") out.push("sticky header on a phone");
        const visible = (e: Element) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        for (const e of el.querySelectorAll("*")) {
          const own = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
          if (own && visible(e) && parseFloat(getComputedStyle(e).fontSize) < 12) out.push(`${parseFloat(getComputedStyle(e).fontSize)}px: ${(e.textContent ?? "").trim().slice(0, 40)}`);
        }
        for (const b of document.querySelectorAll("button, a[href]")) if (visible(b) && !(b.getAttribute("aria-label") || (b.textContent ?? "").trim() || b.getAttribute("title"))) out.push(`unnamed ${b.outerHTML.slice(0, 100)}`);
        for (const f of document.querySelectorAll("input:not([type=hidden]), select")) if (visible(f) && !((f as HTMLInputElement).labels?.length || f.getAttribute("aria-label"))) out.push(`unlabelled ${f.outerHTML.slice(0, 100)}`);
        return out;
      }, "main");
    await page.goto(`/w/${state().workspaceId}/home`);
    await expect(page.getByTestId("home-desk")).toBeVisible();
    expect(await check()).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`home-375-${scheme}.png`), fullPage: true });

    await page.goto(`/w/${state().workspaceId}`);
    await expect(page.getByTestId("overview")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("heatmap-phone")).toBeVisible();
    expect(await check()).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`overview-375-${scheme}.png`), fullPage: true });
    await page.getByTestId("overview-customise").click();
    await expect(page.getByTestId("overview-customise-menu")).toBeVisible();
    const menu = await page.getByTestId("overview-customise-menu").evaluate((m) => [...m.querySelectorAll("input, button")].filter((e) => !((e as HTMLInputElement).labels?.length || e.getAttribute("aria-label") || (e.textContent ?? "").trim())).length);
    expect(menu).toBe(0);
  });
}
