import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { LIVE_LEAVES, QueryRequest, type FilterGroupT } from "@budget/domain";
import { GOLDEN_ASSERTIONS, GOLDEN_EXPERIMENT, asOrgAdmin, withTenant } from "@budget/db";
import { compileQuery, compileTotals } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { plannerOptions } from "../targets/queries/planner-options.js";

/**
 * T-038 done-when (spec §25, §22): the read-out's weighted CPA, test vs control, equals the
 * planner's numbers (Σspend / Σconversions over each scope's live leaves, not an average of CPAs);
 * concluding requires a decision and posts it as a thread comment on every linked envelope.
 * Plus: the lifecycle, the `experiment` tag, the search qualifier and the timeline lane.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `experiments-${randomUUID().slice(0, 8)}`;
type Body = Record<string, unknown>;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = `t038-${randomUUID()}`) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const scope = (dims: Record<string, string>): FilterGroupT => ({ logic: "and", children: Object.entries(dims).map(([key, value]) => ({ field: { kind: "dimension", key }, op: "eq", value })) });
// W0-6: the owner has no BYPASSRLS; every raw owner.* read below (all scoped to the golden
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

describe("experiments (T-038)", () => {
  it("weighted CPA, test vs control, equals the planner's numbers (done-when)", async () => {
    const list = await as("planner", "GET", `/workspaces/${golden.workspaceId}/experiments?status=RUNNING`);
    expect(list.status, JSON.stringify(list.body).slice(0, 400)).toBe(200);
    const rows = list.body as unknown as Array<{ id: string; name: string; envelopes: unknown[] }>;
    const seeded = rows.find((x) => x.name === GOLDEN_EXPERIMENT.name);
    expect(seeded?.envelopes).toHaveLength(2);
    const res = await as("planner", "GET", `/experiments/${seeded?.id ?? ""}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    const readout = res.body["readout"] as { test: { metric: string; leafCount: number; actual: string }; control: { metric: string; leafCount: number }; delta: { abs: string; pct: string }; criterionMet: boolean | null; daysRunning: number };

    // The golden plan's totals (Σspend / Σconversions over the facts), committed in golden.assertions.ts.
    expect(readout.test).toMatchObject({ metric: GOLDEN_ASSERTIONS.experiments.test.cpa, leafCount: GOLDEN_ASSERTIONS.experiments.test.leaves });
    expect(readout.control).toMatchObject({ metric: GOLDEN_ASSERTIONS.experiments.control.cpa, leafCount: GOLDEN_ASSERTIONS.experiments.control.leaves });

    // The planner run directly over each scope for the window gives the same numbers.
    const period = { start: GOLDEN_EXPERIMENT.startDate, end: GOLDEN_EXPERIMENT.endDate };
    const ctx = { workspaceId: golden.workspaceId, orgId: golden.orgId, userId: golden.users.planner, isOrgAdmin: false, actorType: "user" as const, requestId: `t038-${randomUUID()}` };
    const planner = async (dims: Record<string, string>) =>
      withTenant(app, ctx, async (tx) => {
        const q = QueryRequest.parse({ workspaceId: golden.workspaceId, filter: { logic: "and", children: [...LIVE_LEAVES, scope(dims)] }, period: { kind: "range", ...period }, measures: ["budget", "actual"], targets: ["cpa"], limit: 1000 });
        const opts = await plannerOptions(tx, { orgId: golden.orgId, workspaceId: golden.workspaceId }, ["cpa"], period);
        const t = compileTotals(q, period, "2026-09-26", opts);
        const [totals] = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(t.sql, ...t.values);
        const c = compileQuery(q, period, "2026-09-26", opts);
        const leaves = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values);
        return { cpa: new Decimal(String(totals?.["kpi_cpa"])).toDecimalPlaces(4).toString(), actual: new Decimal(String(totals?.["actual"])).toFixed(2), leaves };
      });
    const test = await planner(GOLDEN_EXPERIMENT.test);
    const control = await planner(GOLDEN_EXPERIMENT.control);
    expect([readout.test.metric, readout.control.metric]).toEqual([test.cpa, control.cpa]);
    expect(readout.test.actual).toBe(test.actual);
    // Weighted, not the mean of the leaves' CPAs.
    const mean = test.leaves.reduce((s, r) => s.plus(String(r["kpi_cpa"])), new Decimal(0)).div(test.leaves.length).toDecimalPlaces(4).toString();
    expect(mean).not.toBe(readout.test.metric);
    expect(readout.delta.abs).toBe(new Decimal(test.cpa).minus(control.cpa).toString());
    // lte vs control, past minDays: TikTok's CPA is higher, so not met.
    expect(readout.daysRunning).toBeGreaterThanOrEqual(30);
    expect(readout.criterionMet).toBe(new Decimal(test.cpa).lte(control.cpa));
  });

  it("the TEST envelope is tagged `experiment`; search `experiment:running` finds it and the experiment; the timeline shows the lane", async () => {
    const testEnvelope = golden.envelopeIds.get(GOLDEN_EXPERIMENT.linkTest) as string;
    const controlEnvelope = golden.envelopeIds.get(GOLDEN_EXPERIMENT.linkControl) as string;
    const tags = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ entity_id: string }>>(`SELECT tg.entity_id::text FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE t.workspace_id = $1::uuid AND t.name = 'experiment' AND t.kind = 'system'`, golden.workspaceId),
    );
    expect(tags.map((t) => t.entity_id)).toEqual([testEnvelope]);
    const found = await as("planner", "GET", `/workspaces/${golden.workspaceId}/search?q=${encodeURIComponent("experiment:running")}`);
    expect(found.status, JSON.stringify(found.body).slice(0, 400)).toBe(200);
    const groups = found.body["groups"] as Array<{ type: string; hits: Array<{ id: string; deepLink: string }> }>;
    expect(groups.find((g) => g.type === "experiment")?.hits[0]?.deepLink).toMatch(/\/experiments\//);
    expect(groups.find((g) => g.type === "envelope")?.hits.map((x) => x.id).sort()).toEqual([testEnvelope, controlEnvelope].sort());
    expect((await as("planner", "GET", `/workspaces/${golden.workspaceId}/search?q=${encodeURIComponent("experiment:concluded")}`)).body["groups"]).toEqual([]);
    const byName = await as("planner", "GET", `/workspaces/${golden.workspaceId}/search?q=${encodeURIComponent("tiktok prospecting type:experiment")}`);
    expect((byName.body["groups"] as Array<{ type: string }>).map((g) => g.type)).toEqual(["experiment"]);

    const tl = await as("planner", "GET", `/workspaces/${golden.workspaceId}/timeline?from=2026-01-01&to=2026-12-31&groupBy=country&limit=5000`);
    const bars = tl.body["bars"] as Array<{ kind: string; parentKey: string | null; start: string; end: string; status?: string }>;
    const lanes = bars.filter((b) => b.kind === "experiment");
    expect(lanes.map((b) => [b.parentKey, b.start, b.end, b.status]).sort()).toEqual(
      [
        [controlEnvelope, "2026-01-01", "2026-08-31", "RUNNING · CONTROL"],
        [testEnvelope, "2026-01-01", "2026-08-31", "RUNNING · TEST"],
      ].sort(),
    );
    // The filter attr works in /query too: the envelopes linked to a running experiment.
    const q = await as("planner", "POST", `/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "range", start: "2026-01-01", end: "2026-12-31" }, filter: { logic: "and", children: [{ field: { kind: "attr", key: "experiment" }, op: "eq", value: "RUNNING" }] }, measures: ["budget"], limit: 10 });
    expect((q.body["rows"] as Array<{ envelopeId: string }>).map((r) => r.envelopeId).sort()).toEqual([testEnvelope, controlEnvelope].sort());
  });

  it("lifecycle: create, link, start; conclude requires a decision and posts it on every linked envelope (done-when)", async () => {
    const approverCreate = await as("approver", "POST", `/workspaces/${golden.workspaceId}/experiments`, {});
    expect(approverCreate.status).toBe(403);
    // Pre-EX-4 behavior: an envelope-scoped side picks budgets with the filter (EX-4 defaults a
    // *new* side with no explicit scope kind to `fact`; this test pins `envelope` to keep exercising it).
    const body = { name: "Meta awareness vs consideration", hypothesis: "Consideration buys conversions cheaper in BR.", kind: "OBJECTIVE_TEST", testScopeKind: "envelope", controlScopeKind: "envelope", testFilter: scope({ country: "BR", platform: "meta", objective: "consideration" }), controlFilter: scope({ country: "BR", platform: "meta", objective: "awareness" }), primaryMetric: "cpa", criterion: { comparator: "lte", vs: "control", minDays: 400 }, startDate: "2026-03-01", endDate: "2026-06-30" };
    expect((await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, { ...body, primaryMetric: "nope" })).status).toBe(422);
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body["id"]);
    expect(created.body).toMatchObject({ status: "PLANNED", ownerId: golden.users.planner });

    const leaves = [...golden.envelopeIds.entries()].filter(([k]) => k.startsWith("LATAM/BR/meta/consideration/") || k.startsWith("LATAM/BR/meta/awareness/"));
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    for (const [key, envelopeId] of leaves) {
      const role = key.includes("/consideration/") ? "TEST" : "CONTROL";
      const linked = await as("planner", "POST", `/experiments/${id}/link`, { envelopeId, role });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);
      expect(linked.body["tagged"]).toBe(role === "TEST");
    }
    // Before minDays have run the criterion has no verdict.
    const early = await as("planner", "GET", `/experiments/${id}`);
    expect((early.body["readout"] as { criterionMet: unknown; daysRunning: number })).toMatchObject({ criterionMet: null, daysRunning: 0 });

    expect((await as("planner", "POST", `/experiments/${id}/conclude`, { decision: "Consideration wins; shift the budget." })).status).toBe(409); // still PLANNED
    const patched = await as("planner", "PATCH", `/experiments/${id}`, { hypothesis: "Consideration buys conversions cheaper in Brazil." });
    expect(patched.body).toMatchObject({ hypothesis: "Consideration buys conversions cheaper in Brazil." });
    expect((await as("planner", "POST", `/experiments/${id}/start`)).body).toMatchObject({ status: "RUNNING" });
    expect((await as("planner", "POST", `/experiments/${id}/start`)).status).toBe(409);

    expect((await as("planner", "POST", `/experiments/${id}/conclude`, {})).status).toBe(422);
    expect((await as("planner", "POST", `/experiments/${id}/conclude`, { decision: "too short" })).status).toBe(422);
    const decision = "Consideration wins on CPA; move 20% of awareness into it next quarter.";
    const requestId = `t038-conclude-${randomUUID()}`;
    const concluded = await as("planner", "POST", `/experiments/${id}/conclude`, { decision }, requestId);
    expect(concluded.status, JSON.stringify(concluded.body)).toBe(201);
    expect(concluded.body).toMatchObject({ status: "CONCLUDED", decision, decidedBy: golden.users.planner });
    const threads = concluded.body["threads"] as Array<{ envelopeId: string; threadId: string }>;
    expect(threads.map((t) => t.envelopeId).sort()).toEqual(leaves.map(([, e]) => e).sort());
    // One thread per linked envelope, the decision as its comment, in the envelope's Decision Timeline.
    for (const t of threads) {
      const [row] = await asOwner((tx) =>
        tx.$queryRawUnsafe<Array<{ anchor_type: string; anchor_id: string; body_md: string }>>(`SELECT th.anchor_type, th.anchor_id::text, c.body_md FROM thread th JOIN comment c ON c.thread_id = th.id WHERE th.id = $1::uuid`, t.threadId),
      );
      expect(row).toMatchObject({ anchor_type: "envelope", anchor_id: t.envelopeId });
      expect(row?.body_md).toContain(decision);
    }
    const timeline = await as("planner", "GET", `/envelopes/${threads[0]?.envelopeId ?? ""}/timeline`);
    expect(JSON.stringify(timeline.body)).toContain(decision);
    const audits = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY action`, requestId));
    expect(audits.filter((a) => a.action === "experiment.concluded")).toHaveLength(1);
    expect(audits.filter((a) => a.action === "thread.created")).toHaveLength(threads.length);
    const outbox = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'experiment.changed' AND payload->>'experimentId' = $2`, golden.workspaceId, id),
    );
    expect(Number(outbox[0]?.n)).toBe(2 + leaves.length + 1 + 1); // created, updated, links, started, concluded

    expect((await as("planner", "POST", `/experiments/${id}/abandon`)).status).toBe(409);
    expect((await as("planner", "PATCH", `/experiments/${id}`, { name: "Too late" })).status).toBe(409);
    expect((await as("planner", "POST", `/experiments/${id}/link`, { envelopeId: leaves[0]?.[1], role: "TEST" })).status).toBe(409);
  });

  it("an experiment with no linked envelope cannot be concluded; abandon works from running", async () => {
    const created = await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, { name: "Geo holdout MX", hypothesis: "Pausing MX awareness does not move conversions.", kind: "GEO_HOLDOUT", testScopeKind: "envelope", testFilter: scope({ country: "MX" }), primaryMetric: "cpa", criterion: { comparator: "gte", vs: "absolute", value: "10" }, startDate: "2026-02-01", endDate: "2026-04-30" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body["id"]);
    // Absolute criterion: the delta is against the value; no control side.
    const r = (await as("planner", "GET", `/experiments/${id}`)).body["readout"] as { control: unknown; delta: { abs: string } | null; test: { metric: string | null } };
    expect(r.control).toBeNull();
    expect(r.delta?.abs).toBe(new Decimal(r.test.metric ?? 0).minus(10).toString());
    await as("planner", "POST", `/experiments/${id}/start`);
    const refused = await as("planner", "POST", `/experiments/${id}/conclude`, { decision: "No effect seen; keep MX awareness on." });
    expect(refused.status).toBe(422);
    expect((await as("planner", "POST", `/experiments/${id}/abandon`)).body).toMatchObject({ status: "ABANDONED" });
    expect((await as("planner", "POST", `/workspaces/${golden.workspaceId}/experiments`, { ...(created.body as Body), controlFilter: null, criterion: { comparator: "lte", vs: "control" } })).status).toBe(422);
  });
});
