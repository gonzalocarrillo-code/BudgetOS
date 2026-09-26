import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "./object-store.js";
import { runIngest, type IngestDeps } from "./pipeline.js";

/**
 * T-036 (spec §24.3): the matching order. 1. an external id resolves the tuple; 2. a match key is
 * looked up on envelope.match_key (or parsed with the source's parse pattern); 3. the tuple. Every
 * matched fact records how (`match_method`); an unmatched one records nothing; the run summary
 * counts spend by method.
 */

const url = (key: string) => process.env[key] ?? "";
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const tenant = { workspaceId: ws, orgId };
const store = new MemoryObjectStore();
const deps = (): IngestDeps => ({ prisma: app, store, reportBucket: "t036-reports" });
const env: Record<string, string> = {};

async function source(name: string, csv: string, mapping: unknown, parsePattern: string | null = null): Promise<string> {
  const id = randomUUID();
  const uri = `gs://t036-uploads/uploads/${ws}/${id}.csv`;
  await store.write(uri, csv, "text/csv");
  await owner.dataSource.create({ data: { id, workspaceId: ws, kind: "csv", name, config: { kind: "csv", uri }, mapping: mapping as object, parsePattern } });
  return id;
}
async function run(sourceId: string) {
  const runId = randomUUID();
  await owner.ingestRun.create({ data: { id: runId, sourceId, status: "queued" } });
  return { runId, result: await runIngest(deps(), tenant, runId) };
}
const methods = async (runId: string) =>
  owner.$queryRawUnsafe<Array<{ envelope_id: string | null; match_method: string | null; amount: string }>>(`SELECT envelope_id::text, match_method, amount::text FROM spend_fact WHERE source_run_id = $1::uuid ORDER BY amount DESC`, runId);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t036" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t036-${ws}`, name: "T-036", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t036.test`, name: "T-036", googleSub: `g-${userId}` } });
  for (const [key, codes] of [["country", ["BR", "MX"]], ["platform", ["meta", "google_ads"]]] as const) {
    const dim = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, userId);
    for (const code of codes) {
      const ext = key === "platform" && code === "meta" ? { meta_account_id: "act_123" } : {};
      await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label, external_ids) VALUES ($1::uuid, $2::uuid, $3, $3, $4::jsonb)`, randomUUID(), dim, code, JSON.stringify(ext));
    }
  }
  for (const [k, dims, key] of [["brMeta", { country: "BR", platform: "meta" }, "br_meta"], ["mxGoogle", { country: "MX", platform: "google_ads" }, "mx_google_ads"]] as const) {
    env[k] = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at, match_key)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $5::uuid, now(), $6)`,
      env[k],
      ws,
      k,
      JSON.stringify(dims),
      userId,
      key,
    );
  }
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM kpi_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)`,
    `DELETE FROM data_source WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
  ])
    await owner.$executeRawUnsafe(sql, ws);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("matching order (T-036, spec §24.3)", () => {
  it("external id, then tuple; unmatched keeps no method; the summary counts spend by method", async () => {
    const csv = ["DATE,COUNTRY,ACCOUNT,SPEND", "2026-03-01,BR,act_123,40.00", "2026-03-01,BR,meta,30.00", "2026-03-01,BR,google_ads,20.00"].join("\n");
    const id = await source("by account", csv, { kind: "spend", columns: { DATE: { role: "period_date" }, COUNTRY: { dimension: "country" }, ACCOUNT: { dimension: "platform" }, SPEND: { role: "amount", currency: "USD" } } });
    const { runId, result } = await run(id);
    expect(await methods(runId)).toEqual([
      { envelope_id: env["brMeta"], match_method: "external_id", amount: "40.00" },
      { envelope_id: env["brMeta"], match_method: "tuple", amount: "30.00" },
      { envelope_id: null, match_method: null, amount: "20.00" }, // BR / google_ads: no envelope
    ]);
    expect(result.coverage).toMatchObject({ matchCoverage: "0.777778", byMethod: { external_id: { rows: 1, spend: "40.00" }, tuple: { rows: 1, spend: "30.00" } } });
    const summary = (await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } })).summary as { byMethod: unknown; matchCoverage: string };
    expect(summary.byMethod).toEqual({ external_id: { rows: 1, spend: "40.00" }, tuple: { rows: 1, spend: "30.00" } });
  });

  it("a match key column is looked up on envelope.match_key, case-insensitively; an unknown key is unmatched, not rejected", async () => {
    const csv = ["DATE,CAMPAIGN,SPEND", "2026-04-01,BR_META,11.00", "2026-04-01,mx_google_ads,12.00", "2026-04-01,nowhere,13.00"].join("\n");
    const id = await source("by key", csv, { kind: "spend", columns: { DATE: { role: "period_date" }, CAMPAIGN: { role: "match_key" }, SPEND: { role: "amount", currency: "USD" } } });
    const { runId, result } = await run(id);
    expect(result).toMatchObject({ rowsRejected: 0 });
    expect(await methods(runId)).toEqual([
      { envelope_id: null, match_method: null, amount: "13.00" },
      { envelope_id: env["mxGoogle"], match_method: "match_key", amount: "12.00" },
      { envelope_id: env["brMeta"], match_method: "match_key", amount: "11.00" },
    ]);
  });

  it("with a parse pattern the key's named groups are dimension values", async () => {
    const csv = ["DATE,CAMPAIGN,SPEND", "2026-05-01,BR_meta_prospecting,7.00", "2026-05-01,ZZ_meta_x,8.00"].join("\n");
    const id = await source("by pattern", csv, { kind: "spend", columns: { DATE: { role: "period_date" }, CAMPAIGN: { role: "match_key" }, SPEND: { role: "amount", currency: "USD" } } }, "^(?<country>[A-Z]{2})_(?<platform>[a-z]+)_");
    const { runId, result } = await run(id);
    expect(result).toMatchObject({ rowsAccepted: 1, rowsRejected: 1 }); // ZZ is not a country
    expect(await methods(runId)).toEqual([{ envelope_id: env["brMeta"], match_method: "match_key", amount: "7.00" }]);
  });
});
