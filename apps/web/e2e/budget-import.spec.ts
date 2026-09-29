import { expect, test } from "@playwright/test";
import { state, tokenFor } from "./auth.js";
import { PORTS } from "./env.js";
import { as } from "./ops.js";

/**
 * D-009 done-when (docs/DATA_PLAN.md §3): from Budgets, download this workspace's template, pick a
 * filled file, read the report line by line (a problem with the nearest value blocks Commit), commit
 * a clean file as drafts under one approval; while it waits, the same file cannot be imported over
 * it; rejected, its new budgets are archived (and leave the shared workspace as it was). The same
 * file importing to "nothing to change" once applied is covered by the API test.
 */
const header = "key,region,country,platform,objective,audience,currency,amount,start_date,end_date";
const good = ["prospecting", "retargeting", "lookalike"].map((a) => `,AMER,US,meta,awareness,${a},USD,1500.00,2027-01-01,2027-12-31`);
const bad = ",AMER,Germny,meta,awareness,prospecting,USD,10.00,2027-01-01,2027-12-31";
const file = (rows: string[]) => ({ name: "amer-2027.csv", mimeType: "text/csv", buffer: Buffer.from([header, ...rows].join("\n")) });

test.describe.configure({ mode: "serial" });
test.describe("budget import from Budgets", () => {
  test("template, report with a problem, a clean file committed as drafts for approval; rejected, its budgets are archived", async ({ page }) => {
    test.setTimeout(90_000);
    await as(page, "planner");
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
    await expect(page.getByTestId("notice-ok")).toContainText("Submitted for approval");
    await expect(page.getByTestId("notice-ok")).toContainText("3 budgets, 4 parents");

    // While it waits for approval, the same file cannot be imported over it.
    await page.getByTestId("budget-import").click();
    await page.getByTestId("import-hierarchy").selectOption({ label: "Region first" });
    await page.getByTestId("import-file").setInputFiles(file(good));
    await expect(page.getByTestId("import-report")).toHaveAttribute("data-error", "3");
    await expect(page.getByTestId("import-problem").first()).toContainText("waiting for approval");

    // Rejected: the budgets it created are archived.
    const admin = await tokenFor("admin");
    const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${PORTS.api}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${admin}`, "x-workspace-id": state().workspaceId, "content-type": "application/json" } });
    const pending = (await (await api(`/approvals?status=PENDING&limit=50`)).json()) as { rows: Array<{ id: string; summary: string | null }> };
    const request = pending.rows.find((r) => (r.summary ?? "").startsWith("Import:"));
    expect(request).toBeDefined();
    expect((await api(`/approvals/${request?.id}/decisions`, { method: "POST", body: JSON.stringify({ decision: "reject", comment: "e2e: not this year" }) })).status).toBe(201);
    await page.getByTestId("import-file").setInputFiles(file(good));
    await expect(page.getByTestId("import-report")).toHaveAttribute("data-new", "3");
  });
});
