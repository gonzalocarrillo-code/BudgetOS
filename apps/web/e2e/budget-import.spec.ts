import { expect, test } from "@playwright/test";
import { state } from "./auth.js";
import { as } from "./ops.js";

/**
 * D-009 done-when (docs/DATA_PLAN.md §3): from Budgets, download this workspace's template, pick a
 * filled file, read the report line by line (a problem with the nearest value blocks Commit), commit
 * a clean file as drafts, and see that the same file again changes nothing.
 */
const header = "key,region,country,platform,objective,audience,currency,amount,start_date,end_date";
const good = ["prospecting", "retargeting", "lookalike"].map((a) => `,AMER,US,meta,awareness,${a},USD,1500.00,2027-01-01,2027-12-31`);
const bad = ",AMER,Germny,meta,awareness,prospecting,USD,10.00,2027-01-01,2027-12-31";
const file = (rows: string[]) => ({ name: "amer-2027.csv", mimeType: "text/csv", buffer: Buffer.from([header, ...rows].join("\n")) });

test.describe.configure({ mode: "serial" });
test.describe("budget import from Budgets", () => {
  test("template, report with a problem, then a clean file committed as drafts; the same file again changes nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await as(page, "admin");
    await page.goto(`/w/${state().workspaceId}/budgets`);
    await page.getByTestId("budget-import").click();
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("import-hierarchy").selectOption({ label: "Region first" });
    await expect(page.getByTestId("import-commit")).toBeDisabled();

    const download = page.waitForEvent("download");
    await page.getByTestId("import-template").click();
    const template = (await (await (await download).createReadStream()).toArray()).join("");
    expect(template.split("\r\n")[0]).toMatch(/^key,parent_key,region,country,platform,objective,audience,/);

    // A file with a problem: the report names the line, the column and the nearest value.
    await page.getByTestId("import-file").setInputFiles(file([...good, bad]));
    const report = page.getByTestId("import-report");
    await expect(report).toHaveAttribute("data-error", "1");
    await expect(report).toHaveAttribute("data-new", "3");
    await expect(report).toHaveAttribute("data-parents", "4");
    await expect(page.getByTestId("import-line").and(page.locator('[data-line="5"]'))).toContainText("Did you mean DE?");
    await expect(page.getByTestId("import-blocked")).toContainText("1 line has a problem");
    await page.getByTestId("import-reason").fill("FY2027 AMER plan");
    await expect(page.getByTestId("import-commit")).toBeDisabled();

    // The clean file commits.
    await page.getByTestId("import-file").setInputFiles(file(good));
    await expect(report).toHaveAttribute("data-error", "0");
    await expect(page.getByTestId("import-blocked")).toHaveCount(0);
    await page.getByTestId("import-commit").click();
    await expect(page.getByTestId("notice-ok")).toContainText("Imported");
    await expect(page.getByTestId("notice-ok")).toContainText("3 budgets, 4 parents");

    // The same file again: nothing to change.
    await page.getByTestId("budget-import").click();
    await page.getByTestId("import-hierarchy").selectOption({ label: "Region first" });
    await page.getByTestId("import-file").setInputFiles(file(good));
    await expect(page.getByTestId("import-report")).toHaveAttribute("data-same", "3");
    await expect(page.getByTestId("import-blocked")).toContainText("Nothing to change");
  });
});
