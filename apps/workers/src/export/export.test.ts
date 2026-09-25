import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { outbox, withTenant } from "@budget/db";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../ingest/object-store.js";
import { handleExportRequested } from "./export.js";

/**
 * T-023 export-worker on a small workspace: the file holds exactly the rows the filter selects,
 * in the query's order, with the planner's totals; text that a spreadsheet would run as a formula
 * is neutralised in CSV; XLSX has a frozen header and number cells; a bad query fails the job;
 * every outcome writes one audit_event and one outbox row. Golden + API: apps/api/src/modules/exports.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const TODAY = "2026-06-30";
const store = new MemoryObjectStore();
const period = { kind: "range", start: "2026-01-01", end: "2026-12-31" };
const region = (code: string) => ({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: code }] });

async function envelope(name: string, dims: Record<string, string>, budget: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $6::uuid, now())`,
    id, ws, parentId, name, JSON.stringify(dims), userId,
  );
  await owner.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`, v, id, budget, userId);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
  for (const [key, code] of Object.entries(dims)) {
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) SELECT $1::uuid, d.id, dv.id FROM dimension d JOIN dimension_value dv ON dv.dimension_id = d.id WHERE d.org_id = $2::uuid AND d.key = $3 AND dv.code = $4`,
      id, orgId, key, code,
    );
  }
  return id;
}

/** A queued job and its `export.requested` push body, as the API command would leave them. */
async function queue(kind: "csv" | "xlsx", query: Record<string, unknown>) {
  const jobId = randomUUID();
  const tenant = { workspaceId: ws, orgId, userId, isOrgAdmin: false, actorType: "user" as const, requestId: `t023-${jobId}` };
  await withTenant(app, tenant, async (tx) => {
    await tx.exportJob.create({ data: { id: jobId, workspaceId: ws, kind, query: { workspaceId: ws, period, ...query }, filename: "t023", createdBy: userId } });
    await outbox(tx, { workspaceId: ws, topic: "export.requested", payload: { jobId } });
  });
  const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid AND topic = 'export.requested' ORDER BY id DESC LIMIT 1`, ws);
  const body = { message: { data: Buffer.from(JSON.stringify({ jobId })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "export.requested" }, messageId: "m" }, subscription: "export-worker" };
  return { jobId, body };
}
const written = (jobId: string, kind: string) => store.objects.get(`gs://budget-os-uploads/exports/${ws}/${jobId}.${kind}`)?.body;
const effects = async (jobId: string) => ({
  audit: await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'export_job' AND entity_id = $1::uuid`, jobId),
  outbox: await owner.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(`SELECT payload FROM outbox WHERE topic = 'export.completed' AND payload->>'jobId' = $1`, jobId),
});

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t023" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t023-${ws}`, name: "T-023", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t023.test`, name: "T-023", googleSub: `g-${userId}` } });
  for (const [key, label, codes] of [["region", "Region", ["LATAM", "EMEA"]], ["platform", "Platform", ["meta", "tiktok"]]] as const) {
    const id = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $4, 'ENUM', $5::uuid)`, id, orgId, key, label, userId);
    for (const code of codes) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), id, code);
  }
  const latam = await envelope("LATAM", { region: "LATAM" }, "1000.00");
  await envelope("LATAM meta", { region: "LATAM", platform: "meta" }, "300.10", latam);
  await envelope('=HYPERLINK("x")', { region: "LATAM", platform: "tiktok" }, "200.05", latam);
  await envelope("EMEA meta", { region: "EMEA", platform: "meta" }, "50.00");
});

afterAll(async () => {
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM export_job WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `UPDATE envelope SET current_version_id = NULL, parent_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("export-worker", () => {
  it("CSV: only the filtered rows, in the query's sort, the planner's totals, formulas neutralised, once per event", async () => {
    const { jobId, body } = await queue("csv", { filter: region("LATAM"), measures: ["budget", "actual", "spend_to_date_pct"], sort: [{ key: "budget", dir: "desc" }] });
    expect(await handleExportRequested(app, store, body, TODAY)).toMatchObject({ outcome: "done", rowCount: 3 });
    const csv = String(written(jobId, "csv"));
    expect(csv.startsWith("\u{FEFF}Envelope id,Path,Name,Status,Platform,Region,Currency,Budget,Actual,Spend to date %,Open alerts,Open threads\r\n")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n").map((l) => l.split(","));
    expect(lines.slice(1).map((l) => [l[1], l[7]])).toEqual([
      ["LATAM", "1000.00"],
      ["LATAM / LATAM meta", "300.10"],
      ['"LATAM / =HYPERLINK(""x"")"', "200.05"],
      ["", "1500.15"],
    ]);
    expect(lines[3]?.[2]).toBe(`"'=HYPERLINK(""x"")"`);
    expect(lines[4]?.slice(0, 1)).toEqual(["Total"]);
    expect(csv).not.toContain("EMEA");
    const job = await owner.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "done", rowCount: 3 });
    const fx = await effects(jobId);
    expect(fx.audit.map((a) => a.action)).toEqual(["export.done"]);
    expect(fx.outbox.map((o) => o.payload)).toEqual([{ jobId, requestedBy: userId, status: "done", kind: "csv", rowCount: 3, error: null }]);
    expect(await handleExportRequested(app, store, body, TODAY)).toEqual({ outcome: "duplicate" });
  });

  it("XLSX: grouped rows, frozen bold header, numbers with formats, bold totals", async () => {
    const { jobId, body } = await queue("xlsx", { filter: { logic: "and", children: [{ field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true }] }, groupBy: ["platform"], measures: ["budget", "pace_index"] });
    expect(await handleExportRequested(app, store, body, TODAY)).toMatchObject({ outcome: "done", rowCount: 2 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(written(jobId, "xlsx") as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Export");
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    const values = (n: number) => (sheet?.getRow(n).values as unknown[]).slice(1);
    expect(values(1)).toEqual(["Platform", "Platform (label)", "Currency", "Budget", "Pace index", "Envelopes", "Pending"]);
    expect(sheet?.getRow(1).font?.bold).toBe(true);
    expect(values(2)).toEqual(["meta", "meta", "USD", 350.1, 0, 2, 0]);
    expect(values(3)).toEqual(["tiktok", "tiktok", "USD", 200.05, 0, 1, 0]);
    expect(values(4)).toEqual(["Total", undefined, "USD", 550.15, 0, 3]);
    expect(sheet?.getRow(4).font?.bold).toBe(true);
    expect(sheet?.getColumn(4).numFmt).toBe("#,##0.00");
    expect(wb.getWorksheet("About")?.getRow(1).values).toEqual([undefined, "Workspace", "T-023"]);
  });

  it("a query the planner refuses fails the job, with its audit and outbox rows", async () => {
    const { jobId, body } = await queue("csv", { targets: ["no_such_metric"] });
    expect(await handleExportRequested(app, store, body, TODAY)).toMatchObject({ outcome: "failed", error: "unknown metric no_such_metric" });
    expect(await owner.exportJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "failed", objectUri: null });
    const fx = await effects(jobId);
    expect(fx.audit.map((a) => a.action)).toEqual(["export.failed"]);
    expect(fx.outbox).toHaveLength(1);
  });
});
