import { expect, test, type Page } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * D-004 to D-006 done-when (docs/DATA_PLAN.md §2.3): a client's file with its own column names is
 * mapped once and saved as a profile; the next file from that client maps itself with no edits; a
 * ratio column (tCPA) is recognised and left out; the preview lists a sample's problems, with the
 * nearest known value, before anything runs.
 */
const header = "Fecha,Pais,Plataforma,Inversion,Moneda,Compras,tCPA";
const file = (rows: string[]) => Buffer.from([header, ...rows].join("\n"));
const col = (page: Page, name: string) => page.getByTestId("wizard-column").and(page.locator(`[data-column="${name}"]`)).getByTestId("wizard-choice");

async function upload(page: Page, name: string, rows: string[]) {
  await page.goto(`/w/${state().workspaceId}/admin/sources`);
  await page.getByTestId("source-new").click();
  await page.getByTestId("connector-csv").click();
  await page.getByTestId("wizard-file").setInputFiles({ name, mimeType: "text/csv", buffer: file(rows) });
  await expect(page.getByTestId("mapping-wizard")).toHaveAttribute("data-step", "2");
}

test.describe.configure({ mode: "serial" });
test.describe("mapping profiles, synonyms and the preview", () => {
  test("map a client's file once and save it as a profile; tCPA is left out as a ratio", async ({ page }) => {
    await as(page, "admin");
    await upload(page, "agencia-semana-1.csv", ["2026-03-15,BR,meta,100.00,USD,3,33.33"]);
    await expect(col(page, "Fecha")).toHaveValue("role:period_date"); // a built-in word
    await expect(col(page, "Inversion")).toHaveValue("role:amount");
    await expect(col(page, "Moneda")).toHaveValue("role:currency");
    await expect(col(page, "tCPA")).toHaveValue("role:ignore"); // CPA, a ratio
    await col(page, "Pais").selectOption("dim:country");
    await col(page, "Plataforma").selectOption("dim:platform");
    await col(page, "Compras").selectOption("role:kpi");
    const preview = page.getByTestId("wizard-preview");
    await expect(preview).toHaveAttribute("data-rejected", "0");
    await expect(preview).toContainText("All 1 sample rows would load");
    await expect(page.getByTestId("wizard-preview-column").and(page.locator('[data-column="tCPA"]'))).toContainText("ratio");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-name").fill("Agencia semanal");
    await page.getByTestId("wizard-save-profile").check();
    await page.getByTestId("wizard-profile-name").fill("Agencia (export semanal)");
    await page.locator("label", { hasText: "Run it now" }).locator("input").uncheck().catch(() => undefined);
    await page.getByTestId("wizard-create").click();
    await expect(page.getByTestId("mapping-wizard")).toHaveCount(0);
  });

  test("the next file from the same client maps itself, and follows the profile", async ({ page }) => {
    await as(page, "admin");
    await upload(page, "agencia-semana-2.csv", ["2026-03-22,MX,google_ads,80.00,USD,2,40.00"]);
    await expect(page.getByTestId("wizard-profile")).toHaveAttribute("data-fit", "exact");
    await expect(page.getByTestId("wizard-profile")).toContainText("Agencia (export semanal)");
    await expect(col(page, "Pais")).toHaveValue("dim:country");
    await expect(col(page, "Plataforma")).toHaveValue("dim:platform");
    await expect(col(page, "Compras")).toHaveValue("role:kpi");
    await expect(page.getByTestId("wizard-ok")).toBeVisible();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-follows")).toContainText("Agencia (export semanal)");
  });

  test("the preview names what would be rejected, with the nearest known value", async ({ page }) => {
    await as(page, "admin");
    await upload(page, "agencia-semana-3.csv", ["2026-03-29,Brasill,meta,10.00,USD,1,10.00", "2026-03-30,BR,meta,1.000,50,USD,1,1"]);
    const preview = page.getByTestId("wizard-preview");
    await expect(preview).toHaveAttribute("data-rejected", "2");
    await expect(page.getByTestId("wizard-preview-column").and(page.locator('[data-column="Pais"]'))).toContainText("did you mean BR?");
    await expect(page.getByTestId("wizard-preview-rejects")).toContainText('Row 2: unknown country "Brasill"');
  });
});
