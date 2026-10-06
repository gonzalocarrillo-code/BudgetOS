import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { LIVE_LEAVES } from "@budget/domain";
import { GOLDEN_ASSERTIONS, GOLDEN_MANUAL_ENTRY, asOrgAdmin, goldenPlan } from "@budget/db";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * T-039 done-when (spec §26, §22): an approved manual entry batch appears in /query actuals with
 * `source_system='manual'` and lineage (entered by, approved by); a rejected batch reopens as a
 * draft. Plus: rows validate like ingestion and a batch with invalid rows cannot be submitted.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `manual-${randomUUID().slice(0, 8)}`;
type Body = Record<string, unknown>;
type Issue = { rowNo: number; field: string; message: string };

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = `t039-${randomUUID()}`) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
/** A golden leaf's full tuple: a manual row with it (and channel tv) matches that leaf. */
const leaf = () => {
  const e = goldenPlan().find((x) => x.level === 4 && x.key.startsWith("LATAM/BR/meta/"));
  if (!e) throw new Error("no BR meta leaf");
  return { key: e.key, id: golden.envelopeIds.get(e.key) as string, dims: e.dimensionValues as Record<string, string> };
};
async function actual(envelopeId: string): Promise<string> {
  const res = await as("planner", "POST", `/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "range", start: "2026-08-01", end: "2026-08-31" }, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["actual"], limit: 1000 });
  const row = (res.body["rows"] as Array<{ envelopeId: string; measures: Record<string, string> }>).find((r) => r.envelopeId === envelopeId);
  return row?.measures["actual"] ?? "0.00";
}
async function decide(persona: string, requestId: string, decision: "approve" | "reject", comment?: string) {
  return as(persona, "POST", `/approvals/${requestId}/decisions`, { decision, ...(comment ? { comment } : {}) });
}
// W0-6: the owner has no BYPASSRLS; every raw owner.* read/write below (all scoped to the golden
// workspace/org) needs the same org-admin tenant context real writes get from withTenant.
function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return asOrgAdmin(owner, fn, golden.orgId);
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("manual result entry (T-039)", () => {
  it("the golden draft: valid rows, warned where no budget would take them", async () => {
    const list = await as("planner", "GET", `/workspaces/${golden.workspaceId}/manual-entries?status=DRAFT`);
    expect(list.status, JSON.stringify(list.body).slice(0, 400)).toBe(200);
    const rows = list.body as unknown as Array<{ id: string; channel: string; rowCount: number; totals: { byCurrency: Record<string, string> } }>;
    expect(rows).toHaveLength(GOLDEN_ASSERTIONS.manualEntry.batches);
    expect(rows[0]).toMatchObject({ channel: GOLDEN_MANUAL_ENTRY.channel, rowCount: GOLDEN_ASSERTIONS.manualEntry.rows, totals: { byCurrency: GOLDEN_ASSERTIONS.manualEntry.byCurrency } });
    const one = await as("planner", "GET", `/manual-entries/${rows[0]?.id ?? ""}`);
    expect(one.body["issues"]).toEqual([]);
    // Country-only TV rows: every golden budget is by platform too, so none would take them.
    expect((one.body["warnings"] as Issue[]).map((w) => w.field)).toEqual(["budget", "budget", "budget"]);
  });

  it("approved batch appears in /query actuals with source_system='manual' and lineage (done-when)", async () => {
    const target = leaf();
    const before = await actual(target.id);
    // Invalid rows are saved and returned with reasons; submit refuses them.
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/manual-entries`, {
      channel: "TV",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      rows: [
        { dimensionValues: target.dims, periodDate: "2026-08-10", currency: "usd", amount: "1,000.00", kpis: { conversions: "25" }, note: "Sponsorship spot" },
        { dimensionValues: { country: "XX" }, periodDate: "2026-09-02", currency: "USD", amount: "abc", kpis: { conversions: "many" } },
        { dimensionValues: {}, periodDate: "", currency: "", amount: "", kpis: {} },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body["id"]);
    expect(created.body).toMatchObject({ channel: "tv", status: "DRAFT", totals: { rows: 2 } });
    const issues = created.body["issues"] as Issue[];
    expect(issues.filter((i) => i.rowNo === 1)).toEqual([]);
    expect(issues.filter((i) => i.rowNo === 2).map((i) => i.field).sort()).toEqual(["amount", "dimension:country", "kpi:conversions", "periodDate"]);
    expect(issues.find((i) => i.field === "dimension:country")?.message).toBe('unknown country "XX"');
    const refused = await as("planner", "POST", `/manual-entries/${id}/submit`);
    expect(refused.status).toBe(422);
    expect(String(refused.body["message"])).toBe("Rows to fix before sending for approval: 1");
    expect((await as("approver", "PATCH", `/manual-entries/${id}`, { rows: [] })).status).toBe(403);

    const fixed = await as("planner", "PATCH", `/manual-entries/${id}`, { rows: [(created.body["rows"] as unknown[])[0]] });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ issues: [], warnings: [], totals: { amount: "1000.00", byCurrency: { USD: "1000.00" }, rows: 1 } });

    const submitted = await as("planner", "POST", `/manual-entries/${id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({ autoApproved: false, policy: { name: "Manual results" }, batch: { status: "SUBMITTED" } });
    const requestId = String(submitted.body["requestId"]);
    expect((await as("planner", "PATCH", `/manual-entries/${id}`, { rows: [] })).status).toBe(409);
    // The approval shows the batch; a budget owner is not the step's role (Finance).
    const approval = await as("finance1", "GET", `/approvals/${requestId}`);
    expect(approval.body).toMatchObject({ entityType: "manual_entry", manualEntry: { id, channel: "tv" } });
    expect((await decide("budgetOwner", requestId, "approve")).status).toBe(403);
    expect(await actual(target.id)).toBe(before); // nothing lands before approval

    const approved = await decide("finance1", requestId, "approve");
    expect(approved.body, JSON.stringify(approved.body)).toMatchObject({ status: "APPROVED" });
    expect(await actual(target.id)).toBe(new Decimal(before).plus(1000).toFixed(2));

    const facts = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ source_system: string; source_run_id: string; envelope_id: string; match_method: string; amount: string; dimension_values: Record<string, string> }>>(
        `SELECT source_system, source_run_id::text, envelope_id::text, match_method, amount::text, dimension_values FROM spend_fact WHERE workspace_id = $1::uuid AND source_run_id = $2::uuid`,
        golden.workspaceId,
        id,
      ),
    );
    expect(facts).toEqual([{ source_system: "manual", source_run_id: id, envelope_id: target.id, match_method: "tuple", amount: "1000.00", dimension_values: { ...target.dims, channel: "tv" } }]);
    const kpi = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ metric: string; value: string; envelope_id: string }>>(`SELECT metric, value::text, envelope_id::text FROM kpi_fact WHERE workspace_id = $1::uuid AND source_run_id = $2::uuid`, golden.workspaceId, id),
    );
    expect(kpi).toEqual([{ metric: "conversions", value: "25.0000", envelope_id: target.id }]);

    const detail = await as("planner", "GET", `/manual-entries/${id}`);
    expect(detail.body["status"]).toBe("APPROVED");
    expect(detail.body["lineage"]).toEqual([
      { rowNo: 1, factTable: "spend_fact", metric: null, periodDate: "2026-08-10", enteredBy: golden.users.planner, approvedBy: golden.users.finance1 },
      { rowNo: 1, factTable: "kpi_fact", metric: "conversions", periodDate: "2026-08-10", enteredBy: golden.users.planner, approvedBy: golden.users.finance1 },
    ]);
    const loaded = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ payload: Body }>>(`SELECT payload FROM outbox WHERE workspace_id = $1::uuid AND topic = 'facts.loaded' AND payload->>'manualEntryId' = $2`, golden.workspaceId, id));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.payload["envelopeIds"]).toEqual([target.id]);
    const audits = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'manual_entry' AND entity_id = $1::uuid ORDER BY occurred_at`, id));
    expect(audits.map((a) => a.action)).toEqual(["manual_entry.created", "manual_entry.updated", "manual_entry.approved"]);
    expect((await decide("finance2", requestId, "approve")).status).toBe(409); // closed
  });

  it("a rejected batch reopens as a draft with the decision comment; it can be fixed and sent again (done-when)", async () => {
    const target = leaf();
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/manual-entries`, { channel: "radio", periodStart: "2026-08-01", periodEnd: "2026-08-31", rows: [{ dimensionValues: target.dims, periodDate: "2026-08-20", currency: "USD", amount: "750.00", kpis: {} }] });
    const id = String(created.body["id"]);
    const submitted = await as("planner", "POST", `/manual-entries/${id}/submit`);
    const requestId = String(submitted.body["requestId"]);
    const comment = "The spot ran on 21 August, not the 20th; fix the date.";
    const rejected = await decide("finance1", requestId, "reject", comment);
    expect(rejected.body).toMatchObject({ status: "REJECTED" });
    const detail = await as("planner", "GET", `/manual-entries/${id}`);
    expect(detail.body).toMatchObject({ status: "DRAFT", approvalRequestId: null, lastRequest: { id: requestId, status: "REJECTED", decision: { decision: "reject", comment } } });
    expect(await asOwner((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM spend_fact WHERE source_run_id = $1::uuid`, id))).toEqual([{ n: 0n }]);

    const edited = await as("planner", "PATCH", `/manual-entries/${id}`, { rows: [{ dimensionValues: target.dims, periodDate: "2026-08-21", currency: "USD", amount: "750.00", kpis: {} }] });
    expect(edited.status).toBe(200);
    const again = await as("planner", "POST", `/manual-entries/${id}/submit`);
    expect(again.body).toMatchObject({ batch: { status: "SUBMITTED" } });
    expect(again.body["requestId"]).not.toBe(requestId);
  });

  it("refuses an unknown channel, a reader and rows in a closed period", async () => {
    expect((await as("planner", "POST", `/workspaces/${golden.workspaceId}/manual-entries`, { channel: "carrier_pigeon", periodStart: "2026-08-01", periodEnd: "2026-08-31" })).status).toBe(422);
    expect((await as("approver", "POST", `/workspaces/${golden.workspaceId}/manual-entries`, { channel: "tv", periodStart: "2026-08-01", periodEnd: "2026-08-31" })).status).toBe(403);
    // Close the period holding 5 March for this test (golden restated its Q1 closure), then a row on that day is refused.
    const period = await asOwner((tx) => tx.fiscalPeriod.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, startDate: { lte: new Date("2026-03-05") }, endDate: { gte: new Date("2026-03-05") } }, orderBy: { startDate: "desc" } }));
    const closureId = randomUUID();
    await asOwner((tx) => tx.periodClosure.create({ data: { id: closureId, workspaceId: golden.workspaceId, periodId: period.id, closedBy: golden.users.finance1, registryVersion: {}, bqTable: "t", varianceSummary: {} } }));
    try {
      const res = await as("planner", "POST", `/workspaces/${golden.workspaceId}/manual-entries`, { channel: "tv", periodStart: "2026-03-01", periodEnd: "2026-03-31", rows: [{ dimensionValues: { country: "BR" }, periodDate: "2026-03-05", currency: "USD", amount: "10.00" }] });
      expect((res.body["issues"] as Issue[]).map((i) => i.message)).toContain(`period ${period.key} is closed`);
    } finally {
      await asOwner((tx) => tx.periodClosure.deleteMany({ where: { id: closureId } }));
    }
  });
});
