import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { outbox, unmatchedSpend, withTenant, type TenantContext } from "@budget/db";
import { compileQuery } from "@budget/query-planner";
import { Storage } from "@google-cloud/storage";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteWorkspaceForTests } from "../purge/purge.js";
import { GcsObjectStore, MemoryObjectStore } from "./object-store.js";
import { runIngest, type IngestDeps } from "./pipeline.js";
import type { Connector, RawRow } from "./types.js";
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
const FX2 = "XAG"; // ISO 4217 silver: a second, later-dated rate for the W4-1 projection-currency tests
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
  await owner.fxRate.create({ data: { id: randomUUID(), base: FX2, quote: "USD", rate: "0.2", asOfDate: new Date("2026-06-01"), source: "t017" } });
  env["br"] = await envelope("BR", { country: "BR" });
  env["brMeta"] = await envelope("BR meta", { country: "BR", platform: "meta" }, "APPROVED", env["br"]);
  env["mxMeta"] = await envelope("MX meta", { country: "MX", platform: "meta" });
  env["de"] = await envelope("DE", { country: "DE" }, "ARCHIVED");
  await owner.dataSource.create({ data: { id: sourceId, workspaceId: ws, kind: "csv", name: "T-017 CSV", config: { kind: "csv", uri }, mapping } });
  store = new MemoryObjectStore();
  await store.write(uri, CSV, "text/csv");
});

afterAll(async () => {
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself, including envelope_dimension, which references dimension_value) in the same order
  // `purgeWorkspace` validates against production — before the org-level dimension cleanup below,
  // which would otherwise violate envelope_dimension_value_id_fkey.
  await deleteWorkspaceForTests(owner, ws);
  await owner.$executeRawUnsafe(`UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId); // W3-11 (I-32): self-ref FK
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.fxRate.deleteMany({ where: { base: FX } });
  await owner.fxRate.deleteMany({ where: { base: FX2 } });
  await owner.user.deleteMany({ where: { orgId } });
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
    // W3-4 (audit I-9): the claim left a lease; it stays set (though stale) once the run finishes.
    expect(run.leaseUntil).toBeInstanceOf(Date);
    expect(run.heartbeatAt).toBeInstanceOf(Date);
  });

  it("I-9: a run whose setup throws (before any chunk runs) still ends failed, audited, with one outbox row", async () => {
    // The claim already transitioned this run past queued/running, so runIngest's own setup guard
    // throws before it reads a single row — the exact shape of a worker that crashed mid-setup on
    // an earlier attempt, before W3-4 moved this check inside the try.
    const runId = randomUUID();
    await owner.ingestRun.create({ data: { id: runId, sourceId, status: "failed", summary: { error: "an earlier attempt" } } });
    await expect(runIngest(deps(), tenant, runId)).rejects.toThrow(/ingest run .* is failed/);
    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect((run.summary as { error: string }).error).toMatch(/ingest run .* is failed/);
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.failed'`, runId)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'ingest.failed' AND payload->>'runId' = $1`, runId)).toBe(1);
  });

  it("I-12: a failure after one committed chunk still matches its facts and emits facts.loaded + a data-version bump", async () => {
    const runId = await queueRun();
    const rows: RawRow[] = [
      { COUNTRY: "BR", PLATFORM: "meta", MONTH: "2026-04", SPEND: "10.00", CCY: "USD", CONV: "1" },
      { COUNTRY: "BR", PLATFORM: "meta", MONTH: "2026-04", SPEND: "20.00", CCY: "USD", CONV: "2" },
    ];
    const crashing: Connector = {
      kind: "csv",
      async *read() {
        for (const r of rows) yield r;
        throw new Error("connector crashed");
      },
    };
    const before = (await owner.workspace.findUniqueOrThrow({ where: { id: ws }, select: { settings: true } })).settings as { dataVersion?: number };
    await expect(runIngest({ ...deps(), connector: () => crashing, batchSize: 2 }, tenant, runId)).rejects.toThrow(/connector crashed/);

    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    // The one chunk of 2 rows (batchSize 2) committed before the connector crashed.
    expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE source_run_id = $1::uuid`, runId)).toBe(2);
    const matched = await owner.$queryRawUnsafe<Array<{ envelope_id: string | null }>>(`SELECT DISTINCT envelope_id::text AS envelope_id FROM spend_fact WHERE source_run_id = $1::uuid`, runId);
    expect(matched).toEqual([{ envelope_id: env["brMeta"] }]);
    const [outboxRow] = await owner.$queryRawUnsafe<Array<{ payload: { envelopeIds: string[] } }>>(`SELECT payload FROM outbox WHERE topic = 'facts.loaded' AND payload->>'runId' = $1 ORDER BY outbox.id DESC LIMIT 1`, runId);
    expect(outboxRow?.payload.envelopeIds).toEqual([env["brMeta"]]);
    const after = (await owner.workspace.findUniqueOrThrow({ where: { id: ws }, select: { settings: true } })).settings as { dataVersion?: number };
    expect(after.dataVersion ?? 0).toBeGreaterThan(before.dataVersion ?? 0);
    // Later tests in this file assert absolute fact counts for the whole workspace; keep this
    // test's own facts from leaking into those.
    await owner.$executeRawUnsafe(`DELETE FROM spend_fact WHERE source_run_id = $1::uuid`, runId);
    await owner.$executeRawUnsafe(`DELETE FROM kpi_fact WHERE source_run_id = $1::uuid`, runId);
  });

  it("is idempotent: reloading the same file updates the same facts and keeps their envelopes", async () => {
    const before = await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws);
    const again = await runIngest(deps(), tenant, await queueRun());
    expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid`, ws)).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM kpi_fact WHERE workspace_id = $1::uuid`, ws)).toBe(5);
    expect(again.coverage).toMatchObject({ spendRows: 5, matchedSpendRows: 3, matchCoverage: "0.826087" });
    // ADR-071 (c): the identical file supersedes nothing and duplicates nothing.
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: again.runId } })).summary).toMatchObject({ mode: "full", superseded: 0, coveredRange: { from: "2025-12-01", to: "2030-06-01" } }); // the rows it read, rejected ones included
    expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND superseded_at IS NOT NULL`, ws)).toBe(0);
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
    // ADR-071: a run never supersedes facts in a closed period it may not restate.
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: blocked.runId } })).summary).toMatchObject({ superseded: 0 });
    expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND period_date = '2026-02-01' AND superseded_at IS NULL`, ws)).toBe(2);

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

/**
 * ADR-071 fact identity: a fact is its source's business key (or the source's `row_id`), never its
 * measure. A full extract is authoritative for the dates it covers; an incremental run upserts by row id.
 */
describe("fact identity and reconciliation (ADR-071)", () => {
  const live = (sql: string, ...args: unknown[]) => count(sql.replace("WHERE", "WHERE superseded_at IS NULL AND"), ...args);
  const month = async (envelopeId: string, m: string) =>
    (await owner.$queryRawUnsafe<Array<{ amount: string; n: bigint }>>(`SELECT amount_reporting::text AS amount, fact_count AS n FROM spend_month WHERE workspace_id = $1::uuid AND envelope_id = $2::uuid AND month = $3::date`, ws, envelopeId, m)).map((r) => ({ amount: r.amount, n: Number(r.n) }));
  const actual = async (envelopeId: string, start: string, end: string) => {
    const q = QueryRequest.parse({ workspaceId: ws, measures: ["actual"], period: { kind: "range", start, end }, limit: 10 });
    const c = compileQuery(q, { start, end }, "2026-12-31", { hasProjections: false, envelopeIds: [envelopeId] });
    const [row] = await withTenant(app, ctx(), (tx) => tx.$queryRawUnsafe<Array<{ actual: unknown }>>(c.sql, ...c.values));
    return String(row?.actual);
  };
  const queue = async (source: string, summary: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await owner.ingestRun.create({ data: { id, sourceId: source, status: "queued", summary: summary as never } });
    return id;
  };

  describe("incremental warehouse source (row_id)", () => {
    const bq = randomUUID();
    let rows: RawRow[] = [];
    const sinces: Array<Date | undefined> = [];
    const connector: Connector = {
      kind: "bigquery",
      async *read(_s, _secret, since) {
        sinces.push(since);
        for (const r of rows) yield r;
      },
    };
    const wh = (): IngestDeps => ({ ...deps(), connector: () => connector });
    const row = (id: string, day: string, spend: string, updated: string): RawRow => ({ ID: id, COUNTRY: "BR", PLATFORM: "meta", DAY: day, SPEND: spend, CCY: "USD", UPDATED_AT: updated });
    const whMapping = { kind: "spend", columns: { ID: { role: "row_id" }, COUNTRY: { dimension: "country" }, PLATFORM: { dimension: "platform", transform: "lower" }, DAY: { role: "period_date" }, SPEND: { role: "amount" }, CCY: { role: "currency" }, UPDATED_AT: { role: "ignore" } } };

    beforeAll(async () => {
      await owner.dataSource.create({ data: { id: bq, workspaceId: ws, kind: "bigquery", name: "warehouse", config: { kind: "bigquery", projectId: "budget-test", dataset: "d", table: "spend", updatedAtColumn: "UPDATED_AT" }, mapping: whMapping } });
    });

    it("(a) a re-delivered row with a changed amount updates its one fact; spend_month keeps one fact with the new amount", async () => {
      rows = [row("r1", "2026-05-03", "1000.00", "2026-05-04T00:00:00Z"), row("r2", "2026-05-04", "10.00", "2026-05-05T00:00:00Z")];
      const first = await runIngest(wh(), tenant, await queue(bq));
      expect(sinces.at(-1)).toBeUndefined(); // the first run reads everything
      expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: first.runId } })).summary).toMatchObject({ mode: "full", superseded: 0 });
      expect(await month(env["brMeta"] as string, "2026-05-01")).toEqual([{ amount: "1010.00", n: 2 }]);

      rows = [row("r1", "2026-05-03", "1200.00", "2026-05-09T00:00:00Z")]; // the warehouse restated r1
      const second = await runIngest(wh(), tenant, await queue(bq));
      const since = sinces.at(-1);
      expect(since).toBeInstanceOf(Date);
      const started = (await owner.ingestRun.findUniqueOrThrow({ where: { id: first.runId } })).startedAt;
      expect(since?.getTime()).toBeLessThan(started.getTime()); // an overlap window before the last run (I-30)
      expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: second.runId } })).summary).toMatchObject({ mode: "incremental", superseded: 0 });
      const r1 = await owner.$queryRawUnsafe<Array<{ amount: string; superseded: boolean }>>(
        `SELECT amount::text, superseded_at IS NOT NULL AS superseded FROM spend_fact WHERE workspace_id = $1::uuid AND period_date = '2026-05-03'`,
        ws,
      );
      expect(r1).toEqual([{ amount: "1200.00", superseded: false }]);
      // An incremental run cannot see what it was not sent: r2 stays.
      expect(await month(env["brMeta"] as string, "2026-05-01")).toEqual([{ amount: "1210.00", n: 2 }]);
      expect(await actual(env["brMeta"] as string, "2026-05-01", "2026-05-31")).toBe("1210");
    });

    it("a row whose date moved leaves its old date (superseded there)", async () => {
      rows = [row("r1", "2026-06-02", "1200.00", "2026-05-10T00:00:00Z")];
      await runIngest(wh(), tenant, await queue(bq));
      expect(await month(env["brMeta"] as string, "2026-05-01")).toEqual([{ amount: "10.00", n: 1 }]);
      expect(await month(env["brMeta"] as string, "2026-06-01")).toEqual([{ amount: "1200.00", n: 1 }]);
      expect(await live(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND period_date BETWEEN '2026-05-01' AND '2026-06-30'`, ws)).toBe(2);
    });

    it("a full resync reads everything and supersedes what the warehouse no longer has", async () => {
      rows = [row("r1", "2026-06-02", "1200.00", "2026-05-10T00:00:00Z"), row("r3", "2026-05-01", "5.00", "2026-05-11T00:00:00Z")]; // r2 was deleted upstream
      const full = await runIngest(wh(), tenant, await queue(bq, { mode: "full" }));
      expect(sinces.at(-1)).toBeUndefined();
      expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: full.runId } })).summary).toMatchObject({ mode: "full", superseded: 1, coveredRange: { from: "2026-05-01", to: "2026-06-02" } });
      expect(full.envelopeIds).toContain(env["brMeta"]);
      expect(await month(env["brMeta"] as string, "2026-05-01")).toEqual([{ amount: "5.00", n: 1 }]);
    });
  });

  describe("full extract (CSV)", () => {
    const csv = randomUUID();
    const file = `gs://t017-uploads/uploads/${ws}/july.csv`;
    const lines = (...rs: string[]) => ["COUNTRY,PLATFORM,MONTH,SPEND,CCY,CONV", ...rs].join("\n");
    const jul = ["BR,meta,2026-07-01,100.00,USD,1", "BR,meta,2026-07-10,50.00,USD,2", "BR,meta,2026-07-20,25.00,USD,3"];

    beforeAll(async () => {
      await owner.dataSource.create({ data: { id: csv, workspaceId: ws, kind: "csv", name: "July", config: { kind: "csv", uri: file }, mapping: { ...mapping, columns: { ...mapping.columns, MONTH: { role: "period_date", format: "yyyy-MM-dd" } } } } });
    });

    it("(b) a row missing from a re-extract is superseded: not in actual, not in spend_month", async () => {
      await store.write(file, lines(...jul), "text/csv");
      await runIngest(deps(), tenant, await queue(csv));
      expect(await actual(env["brMeta"] as string, "2026-07-01", "2026-07-31")).toBe("175");
      expect(await month(env["brMeta"] as string, "2026-07-01")).toEqual([{ amount: "175.00", n: 3 }]);

      await store.write(file, lines(jul[0] as string, (jul[2] as string).replace("25.00", "30.00")), "text/csv"); // the 10th is gone, the 20th restated
      const again = await runIngest(deps(), tenant, await queue(csv));
      expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: again.runId } })).summary).toMatchObject({ mode: "full", superseded: 2, coveredRange: { from: "2026-07-01", to: "2026-07-20" } }); // its spend and its KPI
      const gone = await owner.$queryRawUnsafe<Array<{ by: string | null }>>(`SELECT superseded_by_run_id::text AS by FROM spend_fact WHERE workspace_id = $1::uuid AND period_date = '2026-07-10' AND superseded_at IS NOT NULL`, ws);
      expect(gone).toEqual([{ by: again.runId }]);
      expect(await actual(env["brMeta"] as string, "2026-07-01", "2026-07-31")).toBe("130");
      expect(await actual(env["brMeta"] as string, "2026-07-05", "2026-07-25")).toBe("30"); // the edge path reads spend_fact
      expect(await month(env["brMeta"] as string, "2026-07-01")).toEqual([{ amount: "130.00", n: 2 }]);
      expect(await live(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND period_date BETWEEN '2026-07-01' AND '2026-07-31'`, ws)).toBe(2);
      expect(await live(`SELECT count(*) AS n FROM kpi_fact WHERE workspace_id = $1::uuid AND period_date BETWEEN '2026-07-01' AND '2026-07-31'`, ws)).toBe(2);

      // The row comes back: the same fact is live again.
      await store.write(file, lines(...jul), "text/csv");
      const back = await runIngest(deps(), tenant, await queue(csv));
      expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: back.runId } })).summary).toMatchObject({ superseded: 0 });
      expect(await month(env["brMeta"] as string, "2026-07-01")).toEqual([{ amount: "175.00", n: 3 }]);
      expect(await count(`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = $1::uuid AND period_date BETWEEN '2026-07-01' AND '2026-07-31'`, ws)).toBe(3);
    });
  });

  it("(d) an incremental source without a row_id column fails its run with what to map", async () => {
    const bad = randomUUID();
    await owner.dataSource.create({
      data: { id: bad, workspaceId: ws, kind: "snowflake", name: "no row id", config: { kind: "snowflake", account: "a", username: "u", warehouse: "w", database: "d", schema: "s", view: "V", secretRef: "projects/p/secrets/s" }, mapping: { ...mapping, columns: { ...mapping.columns, MONTH: { role: "period_date" } } } },
    });
    const runId = await queue(bad);
    await expect(runIngest({ ...deps(), connector: () => ({ kind: "snowflake", read: async function* () {} }) }, tenant, runId)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/row_id/) });
    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.failed'`, runId)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'ingest.failed' AND payload->>'runId' = $1`, runId)).toBe(1);
  });
});

/**
 * W4-1 (audit T-4): projection facts carry currency and are FX-converted like spend facts, with the
 * same FxCache (same period_date, ROUND_HALF_UP 2dp). A money projection ("spend") with no mapped
 * currency falls back to the workspace's reporting currency instead of being rejected.
 */
describe("projection currency and FX conversion (W4-1, audit T-4)", () => {
  const proj = randomUUID();
  const file = `gs://t017-uploads/uploads/${ws}/projections.csv`;
  const projMapping = {
    kind: "projection",
    columns: {
      COUNTRY: { dimension: "country" },
      PLATFORM: { dimension: "platform", transform: "lower" },
      DAY: { role: "period_date" },
      VALUE: { role: "projection", metric: "spend" },
      CCY: { role: "currency" },
      FV: { role: "formula_version" },
      HE: { role: "horizon_end" },
    },
  };
  const lines = (...rs: string[]) => ["COUNTRY,PLATFORM,DAY,VALUE,CCY,FV,HE", ...rs].join("\n");
  const queue = async (source: string): Promise<string> => {
    const id = randomUUID();
    await owner.ingestRun.create({ data: { id, sourceId: source, status: "queued" } });
    return id;
  };

  beforeAll(async () => {
    await owner.dataSource.create({ data: { id: proj, workspaceId: ws, kind: "csv", name: "Projections", config: { kind: "csv", uri: file }, mapping: projMapping } });
  });

  it("converts a non-reporting-currency row at the fact's date, rejects a row with no FX rate, and leaves a same-currency row with fx_rate_id NULL", async () => {
    await store.write(
      file,
      lines(
        `BR,meta,2026-08-01,100.00,${FX2},v1,2026-12-31`, // FX2→USD rate 0.2 as of 2026-06-01 → 20.00
        `BR,meta,2025-11-01,10.00,${FX2},v1,2026-12-31`, // before any FX2 rate exists → rejected
        `BR,meta,2026-08-03,20.00,USD,v1,2026-12-31`, // already reporting currency
      ),
      "text/csv",
    );
    const result = await runIngest(deps(), tenant, await queue(proj));
    expect(result).toMatchObject({ rowsRead: 3, rowsAccepted: 2, rowsRejected: 1 });
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: result.runId } })).summary).toMatchObject({ projectionCurrency: "column" });
    const report = String(store.objects.get(result.errorReportUri ?? "")?.body ?? "");
    expect(report).toContain(`no FX rate ${FX2}→USD on 2025-11-01`);

    const rows = await owner.$queryRawUnsafe<Array<{ period_date: string; currency: string; value: string; reporting: string; fx_rate_id: string | null }>>(
      `SELECT period_date::text, currency, value::text, value_reporting::text AS reporting, fx_rate_id::text FROM projection_fact WHERE source_run_id = $1::uuid ORDER BY period_date`,
      result.runId,
    );
    expect(rows).toEqual([
      { period_date: "2026-08-01", currency: FX2, value: "100.0000", reporting: "20.0000", fx_rate_id: expect.any(String) },
      { period_date: "2026-08-03", currency: "USD", value: "20.0000", reporting: "20.0000", fx_rate_id: null },
    ]);
  });

  it("falls back to the workspace's reporting currency when the mapping has no currency source, and keeps a non-money metric's currency NULL", async () => {
    const noCcy = randomUUID();
    const noCcyFile = `gs://t017-uploads/uploads/${ws}/projections-no-ccy.csv`;
    await owner.dataSource.create({
      data: { id: noCcy, workspaceId: ws, kind: "csv", name: "Projections no currency", config: { kind: "csv", uri: noCcyFile }, mapping: { ...projMapping, columns: { ...projMapping.columns, CCY: { role: "ignore" } } } },
    });
    await store.write(noCcyFile, ["COUNTRY,PLATFORM,DAY,VALUE,CCY,FV,HE", "BR,meta,2026-08-05,30.00,x,v1,2026-12-31"].join("\n"), "text/csv");
    const result = await runIngest(deps(), tenant, await queue(noCcy));
    expect(result).toMatchObject({ rowsRead: 1, rowsAccepted: 1, rowsRejected: 0 });
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: result.runId } })).summary).toMatchObject({ projectionCurrency: "workspace_fallback" });
    const [row] = await owner.$queryRawUnsafe<Array<{ currency: string; reporting: string; fx_rate_id: string | null }>>(
      `SELECT currency, value_reporting::text AS reporting, fx_rate_id::text FROM projection_fact WHERE source_run_id = $1::uuid`,
      result.runId,
    );
    expect(row).toEqual({ currency: "USD", reporting: "30.0000", fx_rate_id: null });

    // A non-money metric (no "spend") never carries a currency, mapped or not.
    const ratio = randomUUID();
    const ratioFile = `gs://t017-uploads/uploads/${ws}/projections-ratio.csv`;
    await owner.dataSource.create({
      data: { id: ratio, workspaceId: ws, kind: "csv", name: "Projections ratio", config: { kind: "csv", uri: ratioFile }, mapping: { ...projMapping, columns: { ...projMapping.columns, VALUE: { role: "projection", metric: "roas" } } } },
    });
    await store.write(ratioFile, ["COUNTRY,PLATFORM,DAY,VALUE,CCY,FV,HE", "BR,meta,2026-08-06,4.5,USD,v1,2026-12-31"].join("\n"), "text/csv");
    const ratioResult = await runIngest(deps(), tenant, await queue(ratio));
    expect((await owner.ingestRun.findUniqueOrThrow({ where: { id: ratioResult.runId } })).summary).not.toHaveProperty("projectionCurrency");
    const [ratioRow] = await owner.$queryRawUnsafe<Array<{ currency: string | null; reporting: string | null; fx_rate_id: string | null }>>(
      `SELECT currency, value_reporting::text AS reporting, fx_rate_id::text FROM projection_fact WHERE source_run_id = $1::uuid`,
      ratioResult.runId,
    );
    expect(ratioRow).toEqual({ currency: null, reporting: null, fx_rate_id: null });
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
