import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { outbox, unmatchedSpend, withTenant, type TenantContext } from "@budget/db";
import { Storage } from "@google-cloud/storage";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GcsObjectStore, MemoryObjectStore } from "./object-store.js";
import { runIngest, type IngestDeps } from "./pipeline.js";
import { handleIngestRequested } from "./worker.js";

/**
 * T-017 pipeline on its own small workspace: normalize → FX → upsert → match (most specific live
 * envelope) → rejected-rows report → one audit_event + one facts.loaded outbox row per run.
 * The golden ≥ 99% match is asserted by apps/api/src/seed/golden.test.ts.
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
const FX = "XPT"; // ISO 4217 platinum: no other suite uses it
const sourceId = randomUUID();
const uri = `gs://t017-uploads/uploads/${ws}/spend.csv`;
const env: Record<string, string> = {};
const tenant = { workspaceId: ws, orgId };
const ctx = (): TenantContext => ({ workspaceId: ws, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `t017-${randomUUID()}` });

const CSV = [
  "COUNTRY,PLATFORM,MONTH,SPEND,CCY,CONV",
  "BR,Meta,2026-01,100.00,USD,4", // → BR/meta
  "BR,Google Ads,2026-01,50.00,USD,1", // → BR (the parent: no BR/google_ads envelope)
  "MX,meta,2026-02,20.00,XPT,2", // → MX/meta, 40.00 USD at rate 2
  "DE,meta,2026-02,30.00,USD,", // DE is archived → unmatched
  "US,meta,2030-06,10.00,USD,1", // no envelope → unmatched; needs a new partition
  "ZZ,meta,2026-01,5.00,USD,1", // rejected: unknown country
  "BR,meta,2026-01,oops,USD,1", // rejected: not a number
  "MX,meta,2025-12,5.00,XPT,1", // rejected: no XPT rate that early
  "BR,meta,2026-03,,,7", // KPI only → BR/meta
].join("\n");

const mapping = {
  kind: "spend+kpi",
  columns: {
    COUNTRY: { dimension: "country" },
    PLATFORM: { dimension: "platform", transform: "lower", valueMap: { "google ads": "google_ads" } },
    MONTH: { role: "period_date", format: "yyyy-MM" },
    SPEND: { role: "amount" },
    CCY: { role: "currency" },
    CONV: { role: "kpi", metric: "conversions" },
  },
};

let store: MemoryObjectStore;
const deps = (): IngestDeps => ({ prisma: app, store, reportBucket: "t017-reports", batchSize: 4 });

async function envelope(name: string, dims: Record<string, string>, status = "APPROVED", parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, '2026-01-01', '2026-12-31', 'USD', $6::"EnvelopeStatus", $7::uuid, now())`,
    id,
    ws,
    parentId,
    name,
    JSON.stringify(dims),
    status,
    userId,
  );
  return id;
}
async function queueRun(): Promise<string> {
  const id = randomUUID();
  await owner.ingestRun.create({ data: { id, sourceId, status: "queued" } });
  return id;
}
const count = async (sql: string, ...args: unknown[]) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...args))[0]?.n ?? 0);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t017" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t017-${ws}`, name: "T-017", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t017.test`, name: "T-017", googleSub: `g-${userId}` } });
  const dims: Record<string, string> = {};
  for (const [key, codes] of [["country", ["BR", "MX", "DE", "US"]], ["platform", ["meta", "google_ads"]]] as const) {
    dims[key] = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dims[key], orgId, key, userId);
    for (const code of codes) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), dims[key], code);
  }
  await owner.fxRate.create({ data: { id: randomUUID(), base: FX, quote: "USD", rate: "2", asOfDate: new Date("2026-01-01"), source: "t017" } });
  env["br"] = await envelope("BR", { country: "BR" });
  env["brMeta"] = await envelope("BR meta", { country: "BR", platform: "meta" }, "APPROVED", env["br"]);
  env["mxMeta"] = await envelope("MX meta", { country: "MX", platform: "meta" });
  env["de"] = await envelope("DE", { country: "DE" }, "ARCHIVED");
  await owner.dataSource.create({ data: { id: sourceId, workspaceId: ws, kind: "csv", name: "T-017 CSV", config: { kind: "csv", uri }, mapping } });
  store = new MemoryObjectStore();
  await store.write(uri, CSV, "text/csv");
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM kpi_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)`,
    `DELETE FROM data_source WHERE workspace_id = $1::uuid`,
    `DELETE FROM period_closure WHERE workspace_id = $1::uuid`,
    `DELETE FROM fiscal_period WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET parent_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.fxRate.deleteMany({ where: { base: FX } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("runIngest (spec §14)", () => {
  let first: Awaited<ReturnType<typeof runIngest>>;

  it("loads, converts, matches the most specific live envelope and reports rejected rows", async () => {
    const runId = await queueRun();
    first = await runIngest(deps(), tenant, runId);
    expect(first).toMatchObject({ status: "ok", rowsRead: 9, rowsAccepted: 6, rowsRejected: 3 });
    expect(first.envelopeIds).toEqual([env["br"], env["brMeta"], env["mxMeta"]].sort());
    expect(first.coverage).toMatchObject({ spendRows: 5, matchedSpendRows: 3, spend: "230.00", matchedSpend: "190.00", kpiRows: 5, matchedKpiRows: 4, matchCoverage: "0.826087" });

    const byEnvelope = await owner.$queryRawUnsafe<Array<{ envelope_id: string | null; amount: string; reporting: string; currency: string }>>(
      `SELECT envelope_id::text, amount::text, amount_reporting::text AS reporting, currency FROM spend_fact WHERE source_run_id = $1::uuid ORDER BY amount_reporting DESC`,
      runId,
    );
    expect(byEnvelope).toEqual([
      { envelope_id: env["brMeta"], amount: "100.00", reporting: "100.00", currency: "USD" },
      { envelope_id: env["br"], amount: "50.00", reporting: "50.00", currency: "USD" },
      { envelope_id: env["mxMeta"], amount: "20.00", reporting: "40.00", currency: FX },
      { envelope_id: null, amount: "30.00", reporting: "30.00", currency: "USD" },
      { envelope_id: null, amount: "10.00", reporting: "10.00", currency: "USD" },
    ]);
    expect(await count(`SELECT count(*) AS n FROM pg_class WHERE relname = 'spend_fact_203006'`)).toBe(1);

    const report = String(store.objects.get(first.errorReportUri ?? "")?.body ?? "");
    expect(first.errorReportUri).toBe(`gs://t017-reports/reports/${ws}/${runId}.csv`);
    expect(report.split("\n").filter(Boolean)).toEqual([
      "COUNTRY,PLATFORM,MONTH,SPEND,CCY,CONV,_line,_reason",
      'ZZ,meta,2026-01,5.00,USD,1,7,"unknown country ""ZZ"""',
      'BR,meta,2026-01,oops,USD,1,8,"SPEND ""oops"" is not a number"',
      "MX,meta,2025-12,5.00,XPT,1,9,no FX rate XPT→USD on 2025-12-01",
    ]);

    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "ok", rowsRead: 9, rowsAccepted: 6, rowsRejected: 3, errorReportUri: first.errorReportUri });
    expect((run.summary as { matchCoverage: string }).matchCoverage).toBe("0.826087");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.finished'`, runId)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'facts.loaded' AND payload->>'runId' = $1`, runId)).toBe(1);
  });

  it("is idempotent: reloading the same file updates the same facts and keeps their envelopes", async () => {
    const before = await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws);
    const again = await runIngest(deps(), tenant, await queueRun());
    expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws)).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM kpi_fact WHERE workspace_id = $1::uuid`, ws)).toBe(5);
    expect(again.coverage).toMatchObject({ spendRows: 5, matchedSpendRows: 3, matchCoverage: "0.826087" });
  });

  it("queues unmatched spend by tuple", async () => {
    const groups = await withTenant(app, ctx(), (tx) => unmatchedSpend(tx, ws, 50));
    expect(groups.map((g) => [g.dimensionValues, g.amountReporting, g.rows])).toEqual([
      [{ country: "DE", platform: "meta" }, "30.00", 1],
      [{ country: "US", platform: "meta" }, "10.00", 1],
    ]);
  });

  it("rejects facts dated in a closed period, unless the run is that closure's restatement (T-024)", async () => {
    const periodId = randomUUID();
    const closureId = randomUUID();
    await owner.fiscalPeriod.create({ data: { id: periodId, workspaceId: ws, key: "2026-02", kind: "month", startDate: new Date("2026-02-01"), endDate: new Date("2026-02-28") } });
    await owner.periodClosure.create({ data: { id: closureId, workspaceId: ws, periodId, status: "closed", closedBy: userId, registryVersion: {}, bqTable: "t017", varianceSummary: {} } });
    const blocked = await runIngest(deps(), tenant, await queueRun());
    expect(blocked).toMatchObject({ rowsRead: 9, rowsAccepted: 4, rowsRejected: 5 });
    const report = String(store.objects.get(blocked.errorReportUri ?? "")?.body ?? "");
    expect(report.split("\n").filter((l) => l.includes("period 2026-02 is closed"))).toHaveLength(2);

    const flagged = randomUUID();
    await owner.ingestRun.create({ data: { id: flagged, sourceId, status: "queued", summary: { restatementOf: closureId } } });
    expect(await runIngest(deps(), tenant, flagged)).toMatchObject({ rowsAccepted: 6, rowsRejected: 3 });
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: flagged } })).summary).toMatchObject({ restatementOf: closureId });
    await owner.periodClosure.update({ where: { id: closureId }, data: { status: "restated" } });
    expect(await runIngest(deps(), tenant, await queueRun())).toMatchObject({ rowsAccepted: 6, rowsRejected: 3 });
  });

  it("fails the run, audited, when the mapping names a dimension the registry does not have", async () => {
    const bad = randomUUID();
    await owner.dataSource.create({ data: { id: bad, workspaceId: ws, kind: "csv", name: "bad", config: { kind: "csv", uri }, mapping: { ...mapping, columns: { ...mapping.columns, PLATFORM: { dimension: "channel" } } } } });
    const runId = randomUUID();
    await owner.ingestRun.create({ data: { id: runId, sourceId: bad, status: "queued" } });
    await expect(runIngest(deps(), tenant, runId)).rejects.toThrow(/unknown dimensions: channel/);
    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect((run.summary as { error: string }).error).toMatch(/channel/);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.failed'`, runId)).toBe(1);
  });
});

describe("ingest worker (ingest.requested)", () => {
  it("runs a queued run once, however often the message is delivered", async () => {
    const runId = await queueRun();
    await withTenant(app, ctx(), (tx) => outbox(tx, { workspaceId: ws, topic: "ingest.requested", payload: { runId, sourceId } }));
    const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE topic = 'ingest.requested' AND payload->>'runId' = $1`, runId);
    const body = {
      message: { data: Buffer.from(JSON.stringify({ runId, sourceId })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "ingest.requested" }, messageId: "m1" },
      subscription: "projects/p/subscriptions/ingest-worker",
    };
    const first = await handleIngestRequested(app, deps(), body);
    expect(first).toMatchObject({ status: "ok", runId });
    expect(await handleIngestRequested(app, deps(), body)).toEqual({ outcome: "duplicate" });
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.finished'`, runId)).toBe(1);
  });
});

// The rejected-rows report through the GCS emulator (ADR-011): GCS_EMULATOR_HOST=http://127.0.0.1:4443
describe.skipIf(!process.env["GCS_EMULATOR_HOST"])("rejected-rows report in the GCS emulator (T-017 done-when)", () => {
  it("reads the upload from GCS and writes the report next to it", async () => {
    const storage = new Storage({ apiEndpoint: process.env["GCS_EMULATOR_HOST"] ?? "", projectId: "budget-os-test" });
    for (const bucket of ["t017-uploads", "t017-reports"]) {
      const [exists] = await storage.bucket(bucket).exists();
      if (!exists) await storage.createBucket(bucket);
    }
    const gcs = new GcsObjectStore(storage);
    await gcs.write(uri, CSV, "text/csv");
    const result = await runIngest({ ...deps(), store: gcs }, tenant, await queueRun());
    expect(result.rowsRejected).toBe(3);
    expect(await gcs.exists(result.errorReportUri ?? "")).toBe(true);
    const [body] = await storage.bucket("t017-reports").file(`reports/${ws}/${result.runId}.csv`).download();
    expect(body.toString()).toContain('"unknown country ""ZZ"""');
    expect(await gcs.uploadUrl(uri, "text/csv", 600)).toContain("/upload/storage/v1/b/t017-uploads/o?uploadType=media");
  });
});
