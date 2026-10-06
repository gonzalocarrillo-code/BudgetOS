import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * EX-1 (ADR-0085) API: match rules are registry rows written by someone who may edit the budget
 * (in scope); a rule write re-matches the facts it covers at once; coverage splits live spend into
 * matched / unmatched / ambiguous and the three add up to the period's total.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ex1-admin", randomUUID());
const dataAdmin = testUser("ex1-data", randomUUID());
const scopedPlanner = testUser("ex1-scoped", randomUUID());
const viewer = testUser("ex1-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `ex1api-${++seq}-${orgId}`;
const env: Record<string, string> = {};
const runId = randomUUID();

async function call(user: TestUser, method: Method, url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const actions = async (requestId: string) => (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId))).map((r) => r.action);
const outboxFor = async (ruleId: string) => Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'facts.loaded' AND payload->>'matchRuleId' = $2`, ws, ruleId)))[0]?.n ?? 0);
const factState = async (id: string) =>
  (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null; match_method: string | null; match_status: string | null }>>(`SELECT envelope_id::text, match_method, match_status FROM spend_fact WHERE id = $1::uuid`, id)))[0];
const campaignIs = (c: string) => ({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: c }] });

async function fact(dims: Record<string, string>, amount: string, date = "2026-03-01", superseded = false): Promise<string> {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key, superseded_at)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::date, 'USD', $5::numeric, $5::numeric, 'test', $6::uuid, $7, $7, $8::timestamptz)`,
      id,
      ws,
      JSON.stringify(dims),
      date,
      amount,
      runId,
      `ex1api-${id}`,
      superseded ? new Date().toISOString() : null,
    ),
  );
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex1-api" } });
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex1-${ws}`, name: "EX-1", reportingCurrency: "USD" } }));
  await owner.user.createMany({ data: [admin, dataAdmin, scopedPlanner, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: dataAdmin.id, role: "DATA_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: admin.id },
      {
        id: randomUUID(),
        workspaceId: ws,
        principalType: "user",
        principalId: scopedPlanner.id,
        role: "PLANNER",
        scope: { logic: "and", children: [{ field: { kind: "dimension", key: "country" }, op: "eq", value: "MX" }] },
        createdBy: admin.id,
      },
    ],
  });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await asAdmin(async (tx) => {
    for (const [key, codes] of [["country", ["BR", "AR"]], ["campaign", ["c-spring", "c-tie"]]] as const) {
      const dim = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, admin.id);
      for (const code of codes) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), dim, code, `${code} label`);
    }
    for (const [name, dims] of [["br", { country: "BR" }], ["br2", { country: "BR" }], ["ar", { country: "AR" }]] as const) {
      env[name] = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $5::uuid, now())`,
        env[name],
        ws,
        name,
        JSON.stringify(dims),
        admin.id,
      );
    }
  });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [admin.id, dataAdmin.id, scopedPlanner.id, viewer.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("match rules", () => {
  let ruleId: string;
  let spring: string;
  let tie: string;

  it("re-match assigns nothing while two budgets tie on the tuple: the fact is ambiguous", async () => {
    spring = await fact({ country: "AR", campaign: "c-spring" }, "40.00"); // tuple → ar
    tie = await fact({ country: "BR", campaign: "c-tie" }, "25.00"); // br and br2 tie
    await fact({ country: "ZZ", campaign: "c-none" }, "10.00"); // nothing
    await fact({ country: "ZZ", campaign: "c-old" }, "500.00", "2026-03-02", true); // superseded
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/match-rules/rematch`, {}, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ spend: 2, envelopeIds: [env["ar"]] });
    expect(await actions(requestId)).toEqual(["facts.rematched"]);
    expect(await factState(spring)).toMatchObject({ envelope_id: env["ar"], match_method: "tuple" });
    expect(await factState(tie)).toMatchObject({ envelope_id: null, match_status: "ambiguous" });
  });

  it("only someone who may edit the budget, in scope, writes a rule; the predicate's dimensions must exist", async () => {
    expect((await call(viewer, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br"], predicate: campaignIs("c-tie") })).status).toBe(403);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br"], predicate: campaignIs("c-tie") })).status).toBe(403);
    expect((await call(scopedPlanner, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br"], predicate: campaignIs("c-tie") })).status).toBe(403);
    const unknown = await call(admin, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br"], predicate: { logic: "and", children: [{ field: { kind: "dimension", key: "adset" }, op: "eq", value: "x" }] } });
    expect(unknown.status).toBe(422);
    expect(unknown.body["details"]).toMatchObject({ missing: ["adset"] });
    expect((await call(admin, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br"], predicate: { logic: "and", children: [] } })).status).toBe(422);
  });

  it("Assign to budget: a rule campaign = X resolves the ambiguous fact at once; one audit_event + one facts.loaded", async () => {
    const requestId = rid();
    const res = await call(admin, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br2"], predicate: campaignIs("c-tie") }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ruleId = String((res.body["rule"] as { id: string }).id);
    expect(res.body).toMatchObject({ rule: { envelopeId: env["br2"], envelopeName: "br2", startDate: null }, rematch: { spend: 1, envelopeIds: [env["br2"]] } });
    expect(await factState(tie)).toMatchObject({ envelope_id: env["br2"], match_method: "rule", match_status: null });
    expect(await actions(requestId)).toEqual(["match_rule.created"]);
    expect(await outboxFor(ruleId)).toBe(1);
    expect((await call(admin, "POST", `/workspaces/${ws}/match-rules`, { envelopeId: env["br2"], predicate: campaignIs("c-tie") })).status).toBe(409);
    const list = await call(viewer, "GET", `/workspaces/${ws}/match-rules`);
    expect((list.body["rules"] as Array<{ id: string }>).map((r) => r.id)).toEqual([ruleId]);
  });

  it("coverage: matched + unmatched + ambiguous = total live spend, by source and by campaign, open campaigns largest first", async () => {
    expect((await call(viewer, "GET", `/workspaces/${ws}/match-coverage`)).status).toBe(403);
    expect((await call(dataAdmin, "GET", `/workspaces/${ws}/match-coverage?from=2026-05-01&to=2026-01-01`)).status).toBe(422);
    const res = await call(dataAdmin, "GET", `/workspaces/${ws}/match-coverage?from=2026-01-01&to=2026-12-31`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as unknown as { currency: string; totals: Record<string, string | number>; bySource: Array<{ total: string }>; byCampaign: Array<{ campaign: string | null; label: string | null; total: string }>; open: Array<{ campaign: string; status: string; amount: string }> };
    expect(body.currency).toBe("USD");
    expect(body.totals).toMatchObject({ total: "75.00", matched: "65.00", unmatched: "10.00", ambiguous: "0.00", totalRows: 3 });
    expect(new Decimal(String(body.totals["matched"])).plus(String(body.totals["unmatched"])).plus(String(body.totals["ambiguous"])).toFixed(2)).toBe("75.00");
    expect(body.bySource.reduce((s, r) => s.plus(r.total), new Decimal(0)).toFixed(2)).toBe("75.00");
    expect(body.byCampaign.find((c) => c.campaign === "c-spring")).toMatchObject({ label: "c-spring label", total: "40.00" });
    expect(body.open).toEqual([expect.objectContaining({ campaign: "c-none", status: "unmatched", amount: "10.00" })]);
  });

  it("deleting a rule (soft) re-matches its facts without it: the tie is ambiguous again", async () => {
    expect((await call(scopedPlanner, "DELETE", `/match-rules/${ruleId}`)).status).toBe(403);
    const requestId = rid();
    const res = await call(admin, "DELETE", `/match-rules/${ruleId}`, undefined, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ rematch: { spend: 1, envelopeIds: [env["br2"]] } });
    expect(await factState(tie)).toMatchObject({ envelope_id: null, match_status: "ambiguous" });
    expect(await actions(requestId)).toEqual(["match_rule.deleted"]);
    expect(await outboxFor(ruleId)).toBe(2);
    const [row] = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ deleted_at: Date | null }>>(`SELECT deleted_at FROM match_rule WHERE id = $1::uuid`, ruleId));
    expect(row?.deleted_at).not.toBeNull();
    expect((await call(admin, "DELETE", `/match-rules/${ruleId}`)).status).toBe(404);
    const cov = await call(dataAdmin, "GET", `/workspaces/${ws}/match-coverage`);
    expect(cov.body).toMatchObject({ totals: { ambiguous: "25.00" }, open: [{ campaign: "c-tie", status: "ambiguous", candidates: [{ id: [env["br"], env["br2"]].sort()[0] }, { id: [env["br"], env["br2"]].sort()[1] }] }, { campaign: "c-none" }] });
  });
});
