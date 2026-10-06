import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FilterGroupT } from "@budget/domain";
import { asOrgAdmin } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * EX-2 done-when (ADR-086): campaign vs campaign on true facts. A fact-scoped side's totals equal
 * Σ facts; CPA is weighted (Σspend / Σconversions); a day with no fact is `hasData: false` with null
 * metrics, never 0; dates stay editable after the decision (audit + outbox + a system comment);
 * DELETE removes the experiment and its links for good, keeps the audit trail, and 404s afterwards.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `ex2-${randomUUID().slice(0, 8)}`;
const A = `ex2_a_${randomUUID().slice(0, 6)}`;
const B = `ex2_b_${randomUUID().slice(0, 6)}`;
const WINDOW = { startDate: "2026-02-01", endDate: "2026-02-10" };
type Body = Record<string, unknown>;

async function as(persona: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, requestId = `ex2-${randomUUID()}`) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const campaign = (code: string): FilterGroupT => ({ logic: "and", children: [{ field: { kind: "dimension", key: "campaign" }, op: "eq", value: code }] });
function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return asOrgAdmin(owner, fn, golden.orgId);
}
async function fact(table: "spend" | "kpi", date: string, code: string, value: string, metric = "conversions") {
  const dims = JSON.stringify({ platform: "meta", campaign: code });
  await asOwner((tx) =>
    table === "spend"
      ? tx.$executeRawUnsafe(
          `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
           VALUES ($1::uuid, NULL, $2::jsonb, $3::date, 'USD', $4::numeric, $4::numeric, 'ex2', $5::uuid, $6)`,
          golden.workspaceId, dims, date, value, randomUUID(), randomUUID(),
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO kpi_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash)
           VALUES ($1::uuid, NULL, $2::jsonb, $3::date, $4, $5::numeric, 'ex2', $6::uuid, $7)`,
          golden.workspaceId, dims, date, metric, value, randomUUID(), randomUUID(),
        ),
  );
}
const createBody = (over: Body = {}): Body => ({
  name: `Campaign A vs B ${randomUUID().slice(0, 4)}`,
  hypothesis: "Campaign A buys conversions cheaper than B.",
  kind: "CREATIVE_TEST",
  testScopeKind: "fact",
  controlScopeKind: "fact",
  testFilter: campaign(A),
  controlFilter: campaign(B),
  primaryMetric: "cpa",
  criterion: { comparator: "lte", vs: "control" },
  ...WINDOW,
  ...over,
});
interface Side {
  scopeKind: string;
  totals: { spend: string | null; kpis: Record<string, string | null>; metrics: Record<string, string | null>; daysWithData: number; daysInWindow: number };
  days: Array<{ date: string; hasData: boolean; spend: string | null; kpis: Record<string, string | null>; metrics: Record<string, string | null> }>;
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  // A: 02-01 100 / 10 conv, 02-02 50 / 2 conv, 02-04 30 spend only. B: 02-01 40 / 4 conv, 02-03 conversions only.
  await fact("spend", "2026-02-01", A, "100.00");
  await fact("kpi", "2026-02-01", A, "10");
  await fact("spend", "2026-02-02", A, "50.00");
  await fact("kpi", "2026-02-02", A, "2");
  await fact("spend", "2026-02-04", A, "30.00");
  await fact("spend", "2026-02-01", B, "40.00");
  await fact("kpi", "2026-02-01", B, "4");
  await fact("kpi", "2026-02-03", B, "1");
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) {
    await asOwner(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid AND source_system = 'ex2'`, golden.workspaceId);
      await tx.$executeRawUnsafe(`DELETE FROM kpi_fact WHERE workspace_id = $1::uuid AND source_system = 'ex2'`, golden.workspaceId);
    });
    await cleanupGolden(owner, golden);
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("campaign vs campaign experiments (EX-2)", () => {
  it("fact-scoped sides: totals equal Σ facts, CPA is weighted, a day with no facts is null with hasData false (done-when)", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ testScopeKind: "fact", controlScopeKind: "fact" });
    const res = await as("planner", "GET", `/experiments/${String(created.body["id"])}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const sides = res.body["sides"] as { test: Side; control: Side };
    expect(sides.test.scopeKind).toBe("fact");
    expect(sides.test.totals).toMatchObject({ spend: "180.00", daysWithData: 3, daysInWindow: 10 });
    expect(sides.test.totals.kpis["conversions"]).toBe("12");
    // Weighted: 180 / 12 = 15, not the mean of the daily CPAs (10 and 25 → 17.5).
    expect(sides.test.totals.metrics["cpa"]).toBe("15");
    expect(sides.control.totals).toMatchObject({ spend: "40.00", daysWithData: 2, daysInWindow: 10 });
    expect(sides.control.totals.metrics["cpa"]).toBe("8");

    expect(sides.test.days).toHaveLength(10);
    expect(sides.test.days[0]).toMatchObject({ date: "2026-02-01", hasData: true, spend: "100.00" });
    expect(sides.test.days[0]?.metrics["cpa"]).toBe("10");
    // 02-03: no fact row for A: no data, every value null (never 0).
    const empty = sides.test.days[2];
    expect(empty).toMatchObject({ date: "2026-02-03", hasData: false, spend: null });
    expect(Object.values(empty?.kpis ?? {}).every((v) => v === null)).toBe(true);
    expect(Object.values(empty?.metrics ?? {}).every((v) => v === null)).toBe(true);
    // 02-04: spend without conversions: CPA null, not 0 and not infinite.
    expect(sides.test.days[3]).toMatchObject({ hasData: true, spend: "30.00" });
    expect(sides.test.days[3]?.metrics["cpa"]).toBeNull();
    // 02-03 for B: conversions only.
    expect(sides.control.days[2]).toMatchObject({ hasData: true, spend: null });
    expect(sides.control.days[2]?.kpis["conversions"]).toBe("1");

    // The read-out reads the same facts: actual = spend, metric = the weighted CPA, no budget.
    const readout = res.body["readout"] as { test: { actual: string | null; metric: string | null; budget: string | null }; control: { metric: string | null }; delta: { abs: string } };
    expect(readout.test).toMatchObject({ actual: "180.00", metric: "15", budget: null });
    expect(readout.control.metric).toBe("8");
    expect(readout.delta.abs).toBe(new Decimal(15).minus(8).toString());
  });

  it("validates fact sides at the boundary; the campaign picker lists campaigns with spend in the window", async () => {
    const bad = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody({ testFilter: { logic: "and", children: [{ field: { kind: "measure", key: "actual" }, op: "gt", value: 1 }] } }));
    expect(bad.status).toBe(422);
    expect((await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody({ testFilter: { logic: "and", children: [] } }))).status).toBe(422);
    expect((await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody({ startDate: "2026-03-01", endDate: "2026-02-01" }))).status).toBe(422);
    const values = await as("planner", "GET", `/workspaces/${golden.workspaceId}/experiments/scope-values?key=campaign&start=2026-02-01&end=2026-02-10`);
    expect(values.status, JSON.stringify(values.body).slice(0, 300)).toBe(200);
    const rows = values.body as unknown as Array<{ code: string; spend: string; days: number }>;
    expect(rows.filter((r) => r.code === A || r.code === B).map((r) => [r.code, r.spend, r.days])).toEqual([
      [A, "180.00", 3],
      [B, "40.00", 1],
    ]);
    expect((await as("planner", "GET", `/workspaces/${golden.workspaceId}/experiments/scope-values?start=2026-03-01&end=2026-02-01`)).status).toBe(422);
  });

  it("dates stay editable after the decision: audit + outbox + a system comment; other fields stay locked (done-when)", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    const id = String(created.body["id"]);
    const envelopeId = [...golden.envelopeIds.values()][0] as string;
    expect((await as("planner", "POST", `/experiments/${id}/link`, { envelopeId, role: "TEST" })).status).toBe(201);
    await as("planner", "POST", `/experiments/${id}/start`);
    expect((await as("planner", "POST", `/experiments/${id}/conclude`, { decision: "Campaign A wins on CPA; shift budget from B to A." })).status).toBe(201);

    const requestId = `ex2-dates-${randomUUID()}`;
    const patched = await as("planner", "PATCH", `/experiments/${id}`, { startDate: "2025-12-01", endDate: "2027-01-31" }, requestId);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ status: "CONCLUDED", startDate: "2025-12-01", endDate: "2027-01-31" });
    const audits = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ action: string; entity_type: string }>>(`SELECT action, entity_type FROM audit_event WHERE request_id = $1 ORDER BY action`, requestId));
    expect(audits.filter((a) => a.action === "experiment.updated" && a.entity_type === "experiment")).toHaveLength(1);
    const outbox = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'experiment.changed' AND payload->>'experimentId' = $2 AND payload->>'action' = 'experiment.updated'`, golden.workspaceId, id),
    );
    expect(Number(outbox[0]?.n)).toBe(1);
    // The system comment on the linked budget says the dates moved after the decision.
    const comments = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ body_md: string }>>(`SELECT c.body_md FROM thread th JOIN comment c ON c.thread_id = th.id WHERE th.workspace_id = $1::uuid AND th.anchor_type = 'envelope' AND th.anchor_id = $2::uuid AND c.body_md LIKE '%2025-12-01%'`, golden.workspaceId, envelopeId),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body_md).toContain("2026-02-01 – 2026-02-10");

    expect((await as("planner", "PATCH", `/experiments/${id}`, { name: "Too late" })).status).toBe(409);
    expect((await as("planner", "PATCH", `/experiments/${id}`, { startDate: "2026-03-01", endDate: "2026-02-01" })).status).toBe(422);
    expect((await as("planner", "PATCH", `/experiments/${id}`, { startDate: "2028-01-01" })).status).toBe(422); // after the stored end
  });

  it("DELETE removes the experiment and its links for good, keeps the audit trail, 404 afterwards; owner or admin only (done-when)", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    const id = String(created.body["id"]);
    const envelopeId = [...golden.envelopeIds.values()][1] as string;
    expect((await as("planner", "POST", `/experiments/${id}/link`, { envelopeId, role: "TEST" })).status).toBe(201);

    // Another editor who is neither the owner nor an admin: refused.
    expect((await as("budgetOwner", "DELETE", `/experiments/${id}`)).status).toBe(403);
    expect((await as("approver", "DELETE", `/experiments/${id}`)).status).toBe(403);

    const requestId = `ex2-delete-${randomUUID()}`;
    const deleted = await as("planner", "DELETE", `/experiments/${id}`, undefined, requestId);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({ id, deleted: true });
    const left = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ x: bigint; links: bigint; tagged: bigint }>>(
        `SELECT (SELECT count(*) FROM experiment WHERE id = $1::uuid) AS x, (SELECT count(*) FROM experiment_envelope WHERE experiment_id = $1::uuid) AS links,
                (SELECT count(*) FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE t.workspace_id = $2::uuid AND t.name = 'experiment' AND tg.entity_id = $3::uuid) AS tagged`,
        id, golden.workspaceId, envelopeId,
      ),
    );
    expect(left[0]).toMatchObject({ x: 0n, links: 0n, tagged: 0n });
    // Audit rows are never deleted: the earlier ones stay, and the delete adds exactly one.
    const audits = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ action: string; request_id: string }>>(`SELECT action, request_id FROM audit_event WHERE workspace_id = $1::uuid AND entity_type = 'experiment' AND entity_id = $2::uuid ORDER BY occurred_at`, golden.workspaceId, id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["experiment.created", "experiment.linked", "experiment.deleted"]));
    expect(audits.filter((a) => a.action === "experiment.deleted")).toEqual([{ action: "experiment.deleted", request_id: requestId }]);
    const outbox = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'experiment.changed' AND payload->>'experimentId' = $2 AND payload->>'action' = 'experiment.deleted'`, golden.workspaceId, id),
    );
    expect(Number(outbox[0]?.n)).toBe(1);

    expect((await as("planner", "GET", `/experiments/${id}`)).status).toBe(404);
    expect((await as("planner", "DELETE", `/experiments/${id}`)).status).toBe(404);

    // A workspace admin may delete someone else's experiment.
    const other = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    expect((await as("admin", "DELETE", `/experiments/${String(other.body["id"])}`)).status).toBe(200);
  });

  it("envelope-scoped sides keep working and get a daily series from the facts matched to their budgets", async () => {
    const scope = (dims: Record<string, string>): FilterGroupT => ({ logic: "and", children: Object.entries(dims).map(([key, value]) => ({ field: { kind: "dimension", key }, op: "eq", value })) });
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, { ...createBody(), testScopeKind: undefined, controlScopeKind: undefined, testFilter: scope({ country: "BR" }), controlFilter: scope({ country: "MX" }), startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ testScopeKind: "envelope", controlScopeKind: "envelope" });
    const res = await as("planner", "GET", `/experiments/${String(created.body["id"])}`);
    const sides = res.body["sides"] as { test: Side };
    const readout = res.body["readout"] as { test: { actual: string; leafCount: number } };
    expect(sides.test.scopeKind).toBe("envelope");
    expect(sides.test.days).toHaveLength(31);
    expect(readout.test.leafCount).toBeGreaterThan(0);
    // The series sums the facts matched to the side's live leaves: the read-out's actual.
    expect(new Decimal(sides.test.totals.spend ?? 0).toFixed(2)).toBe(readout.test.actual);
  });
});
