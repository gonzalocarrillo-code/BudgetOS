import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { CLOSURE_SINK, RecordingClosureSink } from "./sink.js";

/**
 * T-024 (spec §15) through HTTP. Done-when: an envelope locked by closing its period rejects a
 * draft with 423. Also: every write and approval step on it is 423, the closure writes each
 * template's rows (period and months) to the sink, restating needs admin + reason and gives every
 * envelope its prior status back unless another closed closure still covers it, and the next
 * close of a period writes `_r1`, never over the first table.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let sink: RecordingClosureSink;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t024-planner", randomUUID());
const finance = testUser("t024-finance", randomUUID());
const approver = testUser("t024-approver", randomUUID());
const admin = testUser("t024-admin", randomUUID());
const orgAdmin = testUser("t024-org", randomUUID());
const X = { "x-workspace-id": ws };
const env: Record<string, { id: string; draftVersionId: string }> = {};

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: X, ...(body === undefined ? {} : { body }) });
}
async function envelope(key: string, name: string, amount: string, dates = { startDate: "2026-01-01", endDate: "2026-12-31" }) {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, dimensionValues: { region: key }, ...dates, currency: "USD", amount, ownerId: planner.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body["id"]);
  const submitted = await call(planner, "POST", `/envelopes/${id}/submit`, { versionId: created.body["draftVersionId"] });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  env[key] = { id, draftVersionId: String(created.body["draftVersionId"]) };
}
const status = async (key: string) => (await owner.envelope.findUniqueOrThrow({ where: { id: env[key]?.id ?? "" }, select: { status: true } })).status;
const head = async (key: string) => {
  const e = await owner.envelope.findUniqueOrThrow({ where: { id: env[key]?.id ?? "" }, select: { currentVersionId: true, draftVersionId: true } });
  return e.draftVersionId ?? e.currentVersionId;
};
const close = (periodKey: string, user: TestUser = finance) => call(user, "POST", `/workspaces/${ws}/closures`, { periodKey });

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t024" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t024-${ws}`, name: "T-024", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.createMany({ data: [planner, finance, approver, admin, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: finance.id, role: "FINANCE", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: approver.id, role: "APPROVER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  for (const code of ["latam", "emea", "apac"]) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
  await owner.hierarchyTemplate.create({ data: { id: randomUUID(), workspaceId: ws, name: "By region", path: ["region"], createdBy: orgAdmin.id } });
  await owner.approvalPolicy.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, name: "Large", priority: 1, conditions: { amountAbs: { gte: 1000 } }, chain: [{ role: "APPROVER", minApprovals: 1, timeoutHours: 48 }], blockSelfApproval: true },
      { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 2, conditions: {}, chain: [], blockSelfApproval: true },
    ],
  });
  h = await startHarness();
  sink = h.app.get(CLOSURE_SINK, { strict: false }) as RecordingClosureSink;
  await envelope("latam", "Brazil always-on", "600.00");
  await envelope("emea", "Europe launch", "2000.00"); // pending: the Large policy needs an approver
  await envelope("apac", "APAC 2025 wrap-up", "50.00", { startDate: "2025-10-01", endDate: "2025-12-31" });
  await owner.$executeRawUnsafe(`SELECT ensure_fact_partitions('2026-01-01'::date, 3)`);
  for (const [day, amount] of [["2026-01-15", "100.00"], ["2026-02-10", "40.50"], ["2026-04-02", "7.00"]] as const) {
    await owner.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, loaded_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '{"region":"latam"}', $4::date, 'USD', $5::numeric, $5::numeric, 'csv', $6::uuid, $1, now())`,
      randomUUID(), ws, env["latam"]?.id, day, amount, randomUUID(),
    );
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM closure_envelope WHERE closure_id IN (SELECT id FROM period_closure WHERE workspace_id = $1::uuid)`,
    `DELETE FROM period_closure WHERE workspace_id = $1::uuid`,
    `DELETE FROM fiscal_period WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
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

describe("closures (T-024)", () => {
  let q1 = "";

  it("closing a period locks the envelopes that overlap it; a draft on one is 423 (done-when)", async () => {
    expect(await status("emea")).toBe("PENDING");
    const res = await close("2026-Q1");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    q1 = String(res.body["id"]);
    expect(res.body).toMatchObject({ status: "closed", lockedEnvelopes: 2, period: { key: "2026-Q1", kind: "quarter", start: "2026-01-01", end: "2026-03-31" } });
    expect([await status("latam"), await status("emea"), await status("apac")]).toEqual(["LOCKED", "LOCKED", "APPROVED"]);

    const latam = env["latam"]?.id ?? "";
    const draft = await call(planner, "PATCH", `/envelopes/${latam}/draft`, { amount: "650.00", basedOnVersionId: await head("latam") });
    expect(draft.status, JSON.stringify(draft.body)).toBe(423);
    expect(draft.body).toMatchObject({ code: "LOCKED" });
    expect((await call(planner, "PATCH", `/envelopes/${env["apac"]?.id ?? ""}/draft`, { amount: "55.00", basedOnVersionId: await head("apac") })).status).toBe(200);
  });

  it("the pending request on a locked envelope cannot be decided or withdrawn", async () => {
    const [request] = await owner.approvalRequest.findMany({ where: { workspaceId: ws, status: "PENDING" } });
    expect(request).toBeDefined();
    expect((await call(approver, "POST", `/approvals/${request?.id}/decisions`, { decision: "approve" })).status).toBe(423);
    expect((await call(planner, "POST", `/approvals/${request?.id}/withdraw`, {})).status).toBe(423);
  });

  it("writes every template's rows for the period and each month; the report is the stored summary", async () => {
    const table = `budget_vs_actual_${ws.replace(/-/g, "_")}_2026_q1`;
    const rows = sink.tables.get(table) ?? [];
    const total = rows.filter((r) => r.grain === "total").map((r) => [r.node_path, r.budget, r.actual, r.leaf_count]);
    expect(total).toEqual([
      // The pending envelope has no approved budget yet (the planner's rule): its budget is null.
      ["", "600.00", "140.50", 2],
      ["emea", null, "0.00", 1],
      ["latam", "600.00", "140.50", 1],
    ]);
    expect(rows.filter((r) => r.grain === "month" && r.node_path === "latam").map((r) => [r.month, r.actual, r.budget])).toEqual([
      ["2026-01-01", "100.00", null],
      ["2026-02-01", "40.50", null],
      ["2026-03-01", "0.00", null],
    ]);
    const report = await call(finance, "GET", `/closures/${q1}/report`);
    expect(report.status).toBe(200);
    expect(report.body["summary"]).toMatchObject({ lockedEnvelopes: 2, rows: rows.length, totals: { budget: "600.00", actual: "140.50", variance: "-459.50" }, months: [{ month: "2026-01-01", actual: "100.00" }, { month: "2026-02-01", actual: "40.50" }, { month: "2026-03-01", actual: "0.00" }] });
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'period_closure' AND entity_id = $1::uuid`, q1);
    expect(audits.map((a) => a.action)).toEqual(["closure.created"]);
    const [closed] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'period.closed'`, ws);
    expect(Number(closed?.n)).toBe(1);
  });

  it("refuses a second close, an unfinished period and a non-finance caller", async () => {
    expect((await close("2026-Q1")).status).toBe(409);
    expect((await close("FY2026")).status).toBe(409);
    expect((await close("2026-02", planner)).status).toBe(403);
  });

  it("a month closed inside the quarter keeps its envelopes locked until both are restated", async () => {
    const feb = await close("2026-02");
    expect(feb.status, JSON.stringify(feb.body)).toBe(201);
    expect((await call(admin, "POST", `/closures/${q1}/restate`, {})).status).toBe(422);
    expect((await call(finance, "POST", `/closures/${q1}/restate`, { reason: "late invoices" })).status).toBe(403);
    const restated = await call(admin, "POST", `/closures/${q1}/restate`, { reason: "Late January invoices" });
    expect(restated.status, JSON.stringify(restated.body)).toBe(201);
    expect(restated.body).toMatchObject({ status: "restated", unlockedEnvelopes: 0 });
    expect(await status("latam")).toBe("LOCKED"); // 2026-02 still covers it
    const again = await call(admin, "POST", `/closures/${String(feb.body["id"])}/restate`, { reason: "Reopen February too" });
    expect(again.body).toMatchObject({ unlockedEnvelopes: 2 });
    expect([await status("latam"), await status("emea")]).toEqual(["APPROVED", "PENDING"]);
    const [audit] = await owner.$queryRawUnsafe<Array<{ reason: string }>>(`SELECT reason FROM audit_event WHERE entity_type = 'period_closure' AND entity_id = $1::uuid AND action = 'closure.restated'`, q1);
    expect(audit?.reason).toBe("Late January invoices");
    expect((await call(admin, "POST", `/closures/${q1}/restate`, { reason: "twice" })).status).toBe(409);
  });

  it("after a restatement edits work again, and the next close of the period writes _r1", async () => {
    expect((await call(planner, "PATCH", `/envelopes/${env["latam"]?.id ?? ""}/draft`, { amount: "650.00", basedOnVersionId: await head("latam") })).status).toBe(200);
    const res = await close("2026-Q1");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["table"]).toBe(`closures.budget_vs_actual_${ws.replace(/-/g, "_")}_2026_q1_r1`);
    expect(sink.tables.has(`budget_vs_actual_${ws.replace(/-/g, "_")}_2026_q1`)).toBe(true);
    const list = await call(finance, "GET", `/workspaces/${ws}/closures`);
    expect((list.body as unknown as Array<{ period: { key: string }; status: string }>).map((c) => [c.period.key, c.status])).toEqual([
      ["2026-Q1", "closed"],
      ["2026-02", "restated"],
      ["2026-Q1", "restated"],
    ]);
  });
});
