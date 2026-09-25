import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { GcsObjectStore, handleExportRequested, uploadBucket } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { parseCsv } from "../envelopes/bulk/csv.js";

/**
 * T-023 (plan §6.2, spec §17 `exports`) through HTTP: POST /exports queues a job with one
 * audit_event and one outbox row, the export-worker (fed that outbox row as a push) writes the file
 * to the GCS emulator, and GET /exports/:id hands back a URL that downloads exactly the filtered
 * rows. A scoped caller's file is cut to their scope; jobs are private to their requester.
 * The golden version of the done-when is in seed/golden.test.ts.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t023-planner", randomUUID());
const scoped = testUser("t023-scoped", randomUUID());
const orgAdmin = testUser("t023-org", randomUUID());
const X = { "x-workspace-id": ws };
const storage = new Storage({ apiEndpoint: process.env["GCS_EMULATOR_HOST"] ?? "http://127.0.0.1:4443", projectId: "budget-os-local" });
const store = new GcsObjectStore(storage);
const period = { kind: "range", start: "2026-01-01", end: "2026-12-31" };
const regionIs = (code: string) => ({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: code }] });

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST", url: string, body?: unknown): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: X, ...(body === undefined ? {} : { body }) });
}
const requestExport = (user: TestUser, body: Record<string, unknown>) => call(user, "POST", "/exports", { kind: "csv", ...body, query: { workspaceId: ws, period, measures: ["budget"], ...(body["query"] as object) } });

/** Delivers the job's `export.requested` outbox row to the worker, as Pub/Sub would. */
async function deliver(jobId: string) {
  const [row] = await owner.$queryRawUnsafe<Array<{ id: string; payload: unknown }>>(`SELECT id::text, payload FROM outbox WHERE topic = 'export.requested' AND payload->>'jobId' = $1`, jobId);
  expect(row).toBeDefined();
  const body = { message: { data: Buffer.from(JSON.stringify(row?.payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "export.requested" }, messageId: row?.id ?? "" }, subscription: "export-worker" };
  return handleExportRequested(app, store, body);
}
async function download(user: TestUser, jobId: string): Promise<string[][]> {
  const got = await call(user, "GET", `/exports/${jobId}`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  expect(got.body).toMatchObject({ status: "done", expiresInSeconds: 900 });
  const res = await fetch(String(got.body["downloadUrl"]));
  expect(res.status).toBe(200);
  return parseCsv((await res.text()).replace(/^\u{FEFF}/u, ""));
}

async function envelope(name: string, region: string, amount: string): Promise<void> {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, dimensionValues: { region }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount, ownerId: planner.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const s = await call(planner, "POST", `/envelopes/${String(created.body["id"])}/submit`, { versionId: created.body["draftVersionId"] });
  expect(s.body["autoApproved"]).toBe(true);
}

beforeAll(async () => {
  const [exists] = await storage.bucket(uploadBucket()).exists();
  if (!exists) await storage.createBucket(uploadBucket());
  await owner.organization.create({ data: { id: orgId, name: "t023" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t023-${ws}`, name: "T-023", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.createMany({ data: [planner, scoped, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scoped.id, role: "VIEWER", scope: regionIs("emea"), createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  for (const code of ["latam", "emea"]) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
  await owner.approvalPolicy.create({ data: { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 1, conditions: {}, chain: [], blockSelfApproval: true } });
  h = await startHarness();
  await envelope("Brazil always-on", "latam", "700.00");
  await envelope("Mexico launch", "latam", "300.25");
  await envelope("Europe launch", "emea", "123.45");
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM export_job WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.roleAssignment.deleteMany({ where: { OR: [{ workspaceId: ws }, { principalId: orgAdmin.id }] } });
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("exports (T-023)", () => {
  it("queues a job (audit + outbox), the worker writes it, and the download holds only the filtered rows", async () => {
    const created = await requestExport(planner, { filename: "LATAM budgets", query: { filter: regionIs("latam"), sort: [{ key: "budget", dir: "desc" }] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: "csv", status: "queued", filename: "LATAM budgets", downloadUrl: null });
    const jobId = String(created.body["id"]);
    const audits = await owner.$queryRawUnsafe<Array<{ action: string; actor_id: string }>>(`SELECT action, actor_id::text FROM audit_event WHERE entity_type = 'export_job' AND entity_id = $1::uuid ORDER BY occurred_at`, jobId);
    expect(audits).toEqual([{ action: "export.requested", actor_id: planner.id }]);
    expect((await call(planner, "GET", `/exports/${jobId}`)).body).toMatchObject({ status: "queued", downloadUrl: null });

    expect(await deliver(jobId)).toMatchObject({ outcome: "done", rowCount: 2 });
    const table = await download(planner, jobId);
    expect(table.map((r) => [r[1], r[r.length - 3]])).toEqual([
      ["Path", "Budget"],
      ["Brazil always-on", "700.00"],
      ["Mexico launch", "300.25"],
      ["", "1000.25"],
    ]);
    expect(table.at(-1)?.[0]).toBe("Total");
    const done = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'export_job' AND entity_id = $1::uuid ORDER BY occurred_at`, jobId);
    expect(done.map((a) => a.action)).toEqual(["export.requested", "export.done"]);
    expect(await deliver(jobId)).toEqual({ outcome: "duplicate" });
  });

  it("a scoped caller exports only their scope, whatever the filter asks for", async () => {
    const created = await requestExport(scoped, { query: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = String(created.body["id"]);
    await deliver(jobId);
    const table = await download(scoped, jobId);
    expect(table.slice(1).map((r) => r[1])).toEqual(["Europe launch", ""]);
    expect(table.at(-1)?.[table[0]?.indexOf("Budget") ?? -1]).toBe("123.45");
  });

  it("jobs are private to their requester; an org admin can read them", async () => {
    const created = await requestExport(planner, { query: {} });
    const jobId = String(created.body["id"]);
    expect((await call(scoped, "GET", `/exports/${jobId}`)).status).toBe(404);
    expect((await call(orgAdmin, "GET", `/exports/${jobId}`)).status).toBe(200);
  });

  it("refuses at the boundary what the worker could not run", async () => {
    expect((await requestExport(planner, { kind: "sheets", query: {} })).status).toBe(503);
    expect((await requestExport(planner, { query: { targets: ["no_such_metric"] } })).status).toBe(422);
    expect((await requestExport(planner, { query: { grain: "month" } })).status).toBe(422);
    expect((await call(planner, "POST", "/exports", { kind: "csv", query: { workspaceId: randomUUID(), period } })).status).toBe(422);
    expect((await requestExport(planner, { filename: "../../etc", query: {} })).status).toBe(422);
  });
});
