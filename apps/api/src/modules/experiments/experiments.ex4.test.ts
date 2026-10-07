import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FilterGroupT } from "@budget/domain";
import { asOrgAdmin } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * EX-4 done-when: the campaign picker is gone (owner feedback: "we already have filters that can be
 * campaign"). A side is just the Budgets filter bar's FilterGroup, evaluated on facts; a filter of
 * `campaign = A` returns A's fact totals and nothing of B's. New experiments default to a fact scope
 * when the caller omits testScopeKind/controlScopeKind (envelope stays available and keeps working,
 * ADR-089).
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `ex4-${randomUUID().slice(0, 8)}`;
const A = `ex4_a_${randomUUID().slice(0, 6)}`;
const B = `ex4_b_${randomUUID().slice(0, 6)}`;
const WINDOW = { startDate: "2026-02-01", endDate: "2026-02-10" };

async function as(persona: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, requestId = `ex4-${randomUUID()}`) {
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
           VALUES ($1::uuid, NULL, $2::jsonb, $3::date, 'USD', $4::numeric, $4::numeric, 'ex4', $5::uuid, $6)`,
          golden.workspaceId, dims, date, value, randomUUID(), randomUUID(),
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO kpi_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash)
           VALUES ($1::uuid, NULL, $2::jsonb, $3::date, $4, $5::numeric, 'ex4', $6::uuid, $7)`,
          golden.workspaceId, dims, date, metric, value, randomUUID(), randomUUID(),
        ),
  );
}
const createBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `EX-4 ${randomUUID().slice(0, 4)}`,
  hypothesis: "Campaign A buys conversions cheaper than B.",
  kind: "CREATIVE_TEST",
  testFilter: campaign(A),
  controlFilter: campaign(B),
  primaryMetric: "cpa",
  criterion: { comparator: "lte", vs: "control" },
  ...WINDOW,
  ...over,
});

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  await fact("spend", "2026-02-01", A, "100.00");
  await fact("kpi", "2026-02-01", A, "10");
  await fact("spend", "2026-02-01", B, "40.00");
  await fact("kpi", "2026-02-01", B, "4");
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) {
    await asOwner(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid AND source_system = 'ex4'`, golden.workspaceId);
      await tx.$executeRawUnsafe(`DELETE FROM kpi_fact WHERE workspace_id = $1::uuid AND source_system = 'ex4'`, golden.workspaceId);
    });
    await cleanupGolden(owner, golden);
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("EX-4: filters instead of a campaign picker", () => {
  it("a new experiment defaults to a fact scope when the caller omits testScopeKind/controlScopeKind", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ testScopeKind: "fact", controlScopeKind: "fact" });
  });

  it("a side defined by filter campaign = A returns A's fact totals, independent of B", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody());
    const res = await as("planner", "GET", `/experiments/${String(created.body["id"])}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const sides = res.body["sides"] as { test: { totals: { spend: string | null } }; control: { totals: { spend: string | null } } };
    expect(sides.test.totals.spend).toBe("100.00");
    expect(sides.control.totals.spend).toBe("40.00");
  });

  it("other filter forms (not just campaign = <value>) still scope facts: platform = meta AND campaign in [A, B]", async () => {
    const both: FilterGroupT = {
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "platform" }, op: "eq", value: "meta" },
        { field: { kind: "dimension", key: "campaign" }, op: "in", value: [A, B] },
      ],
    };
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, createBody({ testFilter: both, controlFilter: null, criterion: { comparator: "lte", vs: "absolute", value: "1" } }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await as("planner", "GET", `/experiments/${String(created.body["id"])}`);
    const sides = res.body["sides"] as { test: { totals: { spend: string | null } } };
    // Both A and B run on platform=meta: the filter sums across both campaigns, nothing else in the workspace.
    expect(sides.test.totals.spend).toBe("140.00");
  });

  it("the campaign-picker route is gone", async () => {
    const res = await as("planner", "GET", `/workspaces/${golden.workspaceId}/experiments/scope-values?start=2026-02-01&end=2026-02-10`);
    expect(res.status).toBe(404);
  });
});
