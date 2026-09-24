import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-018 API (spec §11, §17 `pacing`): rules are workspace config written by a workspace-wide
 * rule.manage role; alerts move open → acknowledged → snoozed → resolved (final), each change
 * audited with one outbox row; /pacing reads pace measures through the planner.
 * The evaluator itself is tested in apps/workers/src/pacing.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const budgetOwner = testUser("t018-owner", randomUUID());
const scopedOwner = testUser("t018-scoped", randomUUID());
const planner = testUser("t018-planner", randomUUID());
const viewer = testUser("t018-viewer", randomUUID());
const orgAdmin = testUser("t018-org", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t018api-${++seq}-${orgId}`;
const env: Record<string, string> = {};
let ruleId: string;

async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const actions = async (requestId: string) =>
  (await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId)).map((r) => r.action);
const overPace = { name: "Over-pace", metric: "pace_index", comparator: "gt", threshold: "1.10", consecutiveDays: 3, severity: "warning" };

async function envelope(name: string, dims: Record<string, string>, budget: string, spend: string): Promise<string> {
  const id = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $5::uuid, now())`,
    id,
    ws,
    name,
    JSON.stringify(dims),
    orgAdmin.id,
  );
  await owner.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`, v, id, budget, orgAdmin.id);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
  await owner.$executeRawUnsafe(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash) VALUES ($1::uuid, $2::uuid, $3::jsonb, '2026-03-01', 'USD', $4::numeric, $4::numeric, 'fixture', $5::uuid, $6)`,
    ws,
    id,
    JSON.stringify(dims),
    spend,
    randomUUID(),
    randomUUID(),
  );
  return id;
}
async function alert(envelopeId: string, status = "OPEN"): Promise<string> {
  const id = randomUUID();
  await owner.alert.create({ data: { id, workspaceId: ws, ruleId, envelopeId, severity: "warning", status: status as "OPEN", metricValue: "1.2", threshold: "1.1", context: {} } });
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t018-api" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t018-${ws}`, name: "T-018", reportingCurrency: "USD" } });
  await owner.user.createMany({ data: [budgetOwner, scopedOwner, planner, viewer, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  const latam = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] };
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: budgetOwner.id, role: "BUDGET_OWNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scopedOwner.id, role: "BUDGET_OWNER", scope: latam, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  for (const code of ["latam", "emea"]) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
  env["latam"] = await envelope("LATAM", { region: "latam" }, "1000.00", "700.00");
  env["emea"] = await envelope("EMEA", { region: "emea" }, "1000.00", "100.00");
  for (const [code, id] of [["latam", env["latam"]], ["emea", env["emea"]]] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) SELECT $1::uuid, $2::uuid, id FROM dimension_value WHERE dimension_id = $2::uuid AND code = $3`, id, region, code);
  }
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM alert WHERE workspace_id = $1::uuid`,
    `DELETE FROM rule_state WHERE rule_id IN (SELECT id FROM pacing_rule WHERE workspace_id = $1::uuid)`,
    `DELETE FROM pacing_rule WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [budgetOwner.id, scopedOwner.id, planner.id, viewer.id, orgAdmin.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("rules", () => {
  it("a workspace-wide budget owner creates a rule (audited, rule.changed); planners and scoped owners cannot", async () => {
    expect((await call(planner, "POST", `/workspaces/${ws}/rules`, overPace)).status).toBe(403);
    expect((await call(scopedOwner, "POST", `/workspaces/${ws}/rules`, overPace)).status).toBe(403);
    expect((await call(budgetOwner, "POST", `/workspaces/${ws}/rules`, { ...overPace, metric: "kpi_vs_target_pct" })).status).toBe(422); // needs metricKey
    const requestId = rid();
    const res = await call(budgetOwner, "POST", `/workspaces/${ws}/rules`, overPace, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ruleId = String(res.body["id"]);
    expect(res.body).toMatchObject({ name: "Over-pace", threshold: "1.1", consecutiveDays: 3, metricArgs: {}, delivery: { inApp: true } });
    expect(await actions(requestId)).toEqual(["rule.created"]);
    expect((await call(budgetOwner, "POST", `/workspaces/${ws}/rules`, overPace)).status).toBe(409);
    const list = (await call(viewer, "GET", `/workspaces/${ws}/rules`)).body as unknown as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([ruleId]);
  });

  it("PATCH updates the rule with before/after in the audit row", async () => {
    const requestId = rid();
    const res = await call(budgetOwner, "PATCH", `/rules/${ruleId}`, { threshold: "1.15", severity: "critical" }, requestId);
    expect(res.body).toMatchObject({ threshold: "1.15", severity: "critical" });
    const [a] = await owner.$queryRawUnsafe<Array<{ before: { threshold: string } }>>(`SELECT before FROM audit_event WHERE request_id = $1`, requestId);
    expect(a?.before.threshold).toBe("1.1");
    expect((await call(budgetOwner, "PATCH", `/rules/${ruleId}`, { metric: "kpi_vs_target_pct", metricArgs: {} })).status).toBe(422);
  });
});

describe("alerts", () => {
  it("lists open alerts by default, filtered by status, envelope filter and the caller's scope", async () => {
    const a1 = await alert(env["latam"] as string);
    const a2 = await alert(env["emea"] as string);
    const ids = (res: { body: unknown }) => (res.body as Array<{ id: string }>).map((a) => a.id).sort();
    expect(ids(await call(viewer, "GET", `/alerts`))).toEqual([a1, a2].sort());
    expect(ids(await call(scopedOwner, "GET", `/alerts`))).toEqual([a1]);
    const filter = encodeURIComponent(JSON.stringify({ logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "emea" }] }));
    expect(ids(await call(viewer, "GET", `/alerts?filter=${filter}`))).toEqual([a2]);
    expect(ids(await call(viewer, "GET", `/alerts?status=RESOLVED`))).toEqual([]);
    expect((await call(viewer, "GET", `/alerts?filter=not-json`)).status).toBe(422);
  });

  it("acknowledge → snooze → resolve; each change audited with one alert.changed; resolved is final", async () => {
    const id = (await owner.alert.findFirstOrThrow({ where: { envelopeId: env["latam"] ?? "" } })).id;
    expect((await call(viewer, "PATCH", `/alerts/${id}`, { status: "ACKNOWLEDGED" })).status).toBe(403);
    let requestId = rid();
    const ack = await call(planner, "PATCH", `/alerts/${id}`, { status: "ACKNOWLEDGED", ownerId: planner.id }, requestId);
    expect(ack.body).toMatchObject({ status: "ACKNOWLEDGED", ownerId: planner.id });
    expect(await actions(requestId)).toEqual(["alert.acknowledged"]);
    expect((await call(planner, "PATCH", `/alerts/${id}`, { status: "SNOOZED", snoozedUntil: "2020-01-01T00:00:00.000Z" })).status).toBe(422);
    expect((await call(planner, "PATCH", `/alerts/${id}`, { status: "SNOOZED" })).status).toBe(422);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call(planner, "PATCH", `/alerts/${id}`, { status: "SNOOZED", snoozedUntil: until })).body).toMatchObject({ status: "SNOOZED", snoozedUntil: until });
    requestId = rid();
    const resolved = await call(planner, "PATCH", `/alerts/${id}`, { status: "RESOLVED" }, requestId);
    expect(resolved.body).toMatchObject({ status: "RESOLVED", snoozedUntil: null });
    expect(resolved.body["resolvedAt"]).toEqual(expect.any(String));
    expect(await actions(requestId)).toEqual(["alert.resolved"]);
    const changes = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'alert.changed' AND payload->>'alertId' = $1`, id);
    expect(Number(changes[0]?.n)).toBe(3);
    expect((await call(planner, "PATCH", `/alerts/${id}`, { status: "ACKNOWLEDGED" })).status).toBe(409);
  });

  it("a scoped owner cannot touch an alert outside its scope", async () => {
    const id = (await owner.alert.findFirstOrThrow({ where: { envelopeId: env["emea"] ?? "" } })).id;
    expect((await call(scopedOwner, "PATCH", `/alerts/${id}`, { status: "ACKNOWLEDGED" })).status).toBe(403);
  });
});

describe("pacing view", () => {
  it("returns pace per envelope for the requested period with totals recomputed from sums", async () => {
    const res = await call(viewer, "GET", `/workspaces/${ws}/pacing?period=${encodeURIComponent(JSON.stringify({ kind: "range", start: "2026-01-01", end: "2026-12-31" }))}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as unknown as { period: { start: string }; rows: Array<{ name: string; actual: string; openAlerts: number; cpa: unknown }>; totals: Record<string, string> };
    expect(body.period).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(body.rows.map((r) => [r.name, r.actual]).sort()).toEqual([["EMEA", "100.00"], ["LATAM", "700.00"]]);
    expect(body.rows.find((r) => r.name === "EMEA")?.openAlerts).toBe(1);
    expect(body.totals["actual"]).toBe("800.00");
    expect(body.totals["spend_to_date_pct"]).toMatch(/^0\.4/);
    expect((await call(viewer, "GET", `/workspaces/${ws}/pacing?period=current_quarter`)).status).toBe(200);
    expect((await call(viewer, "GET", `/workspaces/${ws}/pacing?period=someday`)).status).toBe(422);
  });
});
