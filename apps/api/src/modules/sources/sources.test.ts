import { randomUUID } from "node:crypto";
import { MemoryObjectStore, runIngest, uploadBucket } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-017 API (spec §17 `sources`): sources are workspace config (audited, before/after), runs are
 * queued for the ingest worker, unmatched spend is listed by tuple and mapped to an envelope.
 * The pipeline itself is tested in apps/workers; the golden >= 99% match in seed/golden.test.ts.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const dataAdmin = testUser("t017-data", randomUUID());
const planner = testUser("t017-planner", randomUUID());
const orgAdmin = testUser("t017-org", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t017api-${++seq}-${orgId}`;
const uri = (w = ws, name = "spend.csv") => `gs://${uploadBucket()}/uploads/${w}/${name}`;
const mapping = { kind: "spend", columns: { COUNTRY: { dimension: "country" }, MONTH: { role: "period_date", format: "yyyy-MM" }, SPEND: { role: "amount", currency: "USD" } } };
let envelopeId: string;
let savedKey: string | undefined;

async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const actions = async (requestId: string) =>
  (await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId)).map((r) => r.action);
const topics = async (topic: string, key: string, value: string) =>
  Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = $2 AND payload->>$3 = $4`, ws, topic, key, value))[0]?.n ?? 0);

beforeAll(async () => {
  savedKey = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  await owner.organization.create({ data: { id: orgId, name: "t017-api" } });
  await owner.workspace.createMany({ data: [ws, otherWs].map((id) => ({ id, orgId, slug: `t017-${id}`, name: "T-017", reportingCurrency: "USD" })) });
  await owner.user.createMany({ data: [dataAdmin, planner, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: dataAdmin.id, role: "DATA_ADMIN", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const country = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'country', 'Country', 'ENUM', $3::uuid)`, country, orgId, orgAdmin.id);
  for (const code of ["BR", "US"]) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), country, code);
  envelopeId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'BR', '{"country":"BR"}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`,
    envelopeId,
    ws,
    orgAdmin.id,
  );
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  if (savedKey !== undefined) process.env["OPENAI_API_KEY"] = savedKey;
  await h?.close();
  for (const sql of [
    `DELETE FROM spend_fact WHERE workspace_id = ANY($1::uuid[])`,
    `DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = ANY($1::uuid[]))`,
    `DELETE FROM data_source WHERE workspace_id = ANY($1::uuid[])`,
    `DELETE FROM envelope WHERE workspace_id = ANY($1::uuid[])`,
    `DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`,
  ]) {
    await owner.$executeRawUnsafe(sql, [ws, otherWs]);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [dataAdmin.id, planner.id, orgAdmin.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("sources", () => {
  let sourceId: string;

  it("a data admin creates a csv source on this workspace's uploads: one audit_event + one source.changed", async () => {
    expect((await call(planner, "POST", `/workspaces/${ws}/sources`, { name: "x", config: { kind: "csv", uri: uri() }, mapping })).status).toBe(403);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/sources`, { name: "x", config: { kind: "csv", uri: uri(otherWs) }, mapping })).status).toBe(422);
    const bad = await call(dataAdmin, "POST", `/workspaces/${ws}/sources`, { name: "x", config: { kind: "csv", uri: uri() }, mapping: { ...mapping, columns: { ...mapping.columns, PLATFORM: { dimension: "platform" } } } });
    expect(bad.status).toBe(422);
    expect(bad.body["details"]).toMatchObject({ missing: ["platform"] });
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/sources`, { name: "Monthly spend", config: { kind: "csv", uri: uri() }, mapping }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    sourceId = String(res.body["id"]);
    expect(res.body).toMatchObject({ kind: "csv", name: "Monthly spend", isActive: true });
    expect(await actions(requestId)).toEqual(["source.created"]);
    expect(await topics("source.changed", "sourceId", sourceId)).toBe(1);
    const list = (await call(dataAdmin, "GET", `/workspaces/${ws}/sources`)).body as unknown as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toEqual([sourceId]);
  });

  it("PATCH keeps the kind and audits the before state", async () => {
    expect((await call(dataAdmin, "PATCH", `/sources/${sourceId}`, { config: { kind: "sheets", spreadsheetId: "1AbCdEfGhIjKlMnOp", range: "A1:C" } })).status).toBe(422);
    const requestId = rid();
    const res = await call(dataAdmin, "PATCH", `/sources/${sourceId}`, { name: "Monthly spend (US)", schedule: "0 6 * * *" }, requestId);
    expect(res.body).toMatchObject({ name: "Monthly spend (US)", schedule: "0 6 * * *" });
    const [a] = await owner.$queryRawUnsafe<Array<{ before: { name: string } }>>(`SELECT before FROM audit_event WHERE request_id = $1`, requestId);
    expect(a?.before.name).toBe("Monthly spend");
  });

  it("run queues an ingest_run and an ingest.requested event; a second run waits for the first", async () => {
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/sources/${sourceId}/run`, undefined, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ sourceId, status: "queued" });
    expect(await actions(requestId)).toEqual(["ingest.run.queued"]);
    expect(await topics("ingest.requested", "runId", String(res.body["runId"]))).toBe(1);
    expect((await call(dataAdmin, "POST", `/sources/${sourceId}/run`)).status).toBe(409);
    const runs = (await call(dataAdmin, "GET", `/sources/${sourceId}/runs`)).body as unknown as Array<{ id: string; status: string }>;
    expect(runs).toEqual([expect.objectContaining({ id: res.body["runId"], status: "queued" })]);
  });

  it("suggest-mapping is 503 without OPENAI_API_KEY (no stub; ADR-011)", async () => {
    const res = await call(dataAdmin, "POST", `/sources/${sourceId}/suggest-mapping`);
    expect(res.status).toBe(503);
    expect(res.body["code"]).toBe("UNAVAILABLE");
  });

  it("mapping-suggestions (T-032 wizard, before a source exists): validated, 503 without OPENAI_API_KEY, source.manage only", async () => {
    const sample = { header: ["date", "country", "spend"], rows: [["2026-01-01", "BR", 10]] };
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/mapping-suggestions`, sample);
    expect(res.status).toBe(503);
    expect(res.body["code"]).toBe("UNAVAILABLE");
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/mapping-suggestions`, { header: [], rows: [] })).status).toBe(422);
    expect((await call(planner, "POST", `/workspaces/${ws}/mapping-suggestions`, sample)).status).toBe(403);
  });

  it("uploads hands out a URI under this workspace's uploads", async () => {
    const res = await call(dataAdmin, "POST", `/uploads`, { filename: "Q1 spend.csv" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(String(res.body["uri"])).toMatch(new RegExp(`^gs://${uploadBucket()}/uploads/${ws}/[0-9a-f-]{36}-Q1_spend\\.csv$`));
    expect(res.body["uploadUrl"]).toEqual(expect.any(String));
    expect(["PUT", "POST"]).toContain(res.body["method"]); // T-032: the browser uses it (POST against the emulator)
    expect((await call(dataAdmin, "POST", `/uploads`, { filename: "spend.xlsx" })).status).toBe(422);
  });
});

describe("unmatched spend", () => {
  it("lists unmatched spend by tuple and maps it to an envelope (audited, facts.loaded)", async () => {
    const store = new MemoryObjectStore();
    const src = await call(dataAdmin, "POST", `/workspaces/${ws}/sources`, { name: "US spend", config: { kind: "csv", uri: uri(ws, "us.csv") }, mapping });
    await store.write(uri(ws, "us.csv"), "COUNTRY,MONTH,SPEND\nUS,2026-02,70.00\nUS,2026-03,30.00\nBR,2026-02,5.00\n", "text/csv");
    const queued = await call(dataAdmin, "POST", `/sources/${String(src.body["id"])}/run`);
    const run = await runIngest({ prisma: app, store, reportBucket: uploadBucket() }, { workspaceId: ws, orgId }, String(queued.body["runId"]));
    expect(run.coverage).toMatchObject({ spendRows: 3, matchedSpendRows: 1 });

    const list = await call(dataAdmin, "GET", `/workspaces/${ws}/unmatched-spend`);
    expect(list.body).toEqual([{ dimensionValues: { country: "US" }, rows: 2, amountReporting: "100.00", firstDate: "2026-02-01", lastDate: "2026-03-01" }]);
    expect((await call(planner, "GET", `/workspaces/${ws}/unmatched-spend`)).status).toBe(403);

    const requestId = rid();
    const mapped = await call(dataAdmin, "POST", `/workspaces/${ws}/unmatched-spend/map`, { dimensionValues: { country: "US" }, envelopeId }, requestId);
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(201);
    expect(mapped.body).toMatchObject({ envelopeId, spend: 2, kpi: 0, projection: 0 });
    expect(await actions(requestId)).toEqual(["facts.mapped"]);
    expect((await call(dataAdmin, "GET", `/workspaces/${ws}/unmatched-spend`)).body).toEqual([]);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/unmatched-spend/map`, { dimensionValues: { country: "US" }, envelopeId })).status).toBe(404);
  });
});
