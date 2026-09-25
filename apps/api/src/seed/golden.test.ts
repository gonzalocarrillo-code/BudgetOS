import { randomUUID } from "node:crypto";
import { QueryRequest, type FilterGroupT } from "@budget/domain";
import { GOLDEN_ASSERTIONS, GOLDEN_FY, computeTotals, goldenFactsCsv, goldenPlan, unmatchedSpend, withTenant, type TenantContext } from "@budget/db";
import { compileQuery, compileTotals } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb as appDbClient, ownerDb } from "../test-support/harness.js";
import { seedGolden, type GoldenResult } from "./golden.js";
import { cleanupGolden } from "../test-support/golden-cleanup.js";
import { plannerOptions } from "../modules/targets/queries/planner-options.js";
import { GcsObjectStore, parseGsUri, runIngest, uploadBucket } from "@budget/workers";
import { Storage } from "@google-cloud/storage";
import { queueRun } from "../modules/sources/commands/sources.js";
import type { AuthContext } from "../common/tenant.js";
import { submitVersion } from "../modules/envelopes/commands/submit-version.js";
import { createDraftVersion } from "../modules/envelopes/commands/create-draft-version.js";
import { GOLDEN_COLLAB } from "@budget/db";
import { LIVE_LEAVES, handleRollupEvent, handleSearchEvent } from "@budget/workers";
import { compileTree } from "@budget/query-planner";
import { search } from "../modules/search/search.js";
import { updateEnvelope } from "../modules/envelopes/commands/update-envelope.js";

/**
 * T-006 done-when: the golden seed runs through the real commands in under 60 s and
 * `golden.assertions.ts` is committed. Phase 9 also points the planner at those totals: every
 * number below is compiled by @budget/query-planner and run as budget_app under RLS.
 *
 * Regenerate the assertions after an intentional plan change:
 *   apps/api/node_modules/.bin/tsx -e 'import("@budget/db").then(m => console.log(JSON.stringify(m.computeTotals(m.goldenPlan()), null, 2)))'
 */

const owner = ownerDb();
const app = appDbClient();
const slug = `golden-test-${randomUUID().slice(0, 8)}`;
let golden: GoldenResult;
const A = GOLDEN_ASSERTIONS;

const leaves: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: "audience" }, op: "not_empty" }] };
const period = { start: GOLDEN_FY.start, end: GOLDEN_FY.end };
const TODAY = "2026-08-15";

function ctx(): TenantContext {
  return { workspaceId: golden.workspaceId, orgId: golden.orgId, userId: golden.users.planner, isOrgAdmin: false, actorType: "user", requestId: `golden-test-${randomUUID()}` };
}
function request(over: Record<string, unknown>) {
  return QueryRequest.parse({ workspaceId: golden.workspaceId, period: { kind: "range", ...period }, measures: ["budget"], limit: 1000, ...over });
}
async function rows(over: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const c = compileQuery(request(over), period, TODAY);
  return withTenant(app, ctx(), (tx) => tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values));
}
async function total(over: Record<string, unknown>): Promise<string> {
  const c = compileTotals(request(over), period, TODAY);
  const [t] = await withTenant(app, ctx(), (tx) => tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values));
  return new Decimal(String(t?.["budget"] ?? 0)).toFixed(2);
}
async function byDim(dim: string, over: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const out = await rows({ filter: leaves, groupBy: [dim], ...over });
  return Object.fromEntries(out.map((r) => [String(r[`dim_${dim}`]), new Decimal(String(r["budget"])).toFixed(2)]).sort(([a], [b]) => a!.localeCompare(b!)));
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
}, 180_000);

afterAll(async () => {
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("golden.assertions.ts", () => {
  it("is exactly what goldenPlan() implies, and the plan is deterministic", () => {
    expect(computeTotals(goldenPlan())).toEqual(A);
    expect(JSON.stringify(goldenPlan())).toBe(JSON.stringify(goldenPlan()));
  });
});

describe("pnpm db:seed (T-006 done-when)", () => {
  it("seeds through the commands in under 60 seconds", () => {
    expect(golden.created).toBe(true);
    expect(golden.elapsedMs).toBeLessThan(60_000);
  });

  it("is idempotent: an existing golden workspace is left as is", async () => {
    const again = await seedGolden(app, owner, { slug });
    expect(again).toMatchObject({ created: false, workspaceId: golden.workspaceId });
  });

  it("creates the planned envelopes and approved versions, all through audited commands", async () => {
    const ws = golden.workspaceId;
    expect(await owner.envelope.count({ where: { workspaceId: ws } })).toBe(A.envelopes.total);
    expect(await owner.envelope.count({ where: { workspaceId: ws, parentId: null } })).toBe(2);
    const approved = await owner.envelopeVersion.count({ where: { envelope: { workspaceId: ws }, approvedAt: { not: null } } });
    expect(approved).toBe(A.approvedVersions);
    // Everything is approved except the pending bulk change (T-013) and the archived split source (T-014).
    expect(await owner.envelope.count({ where: { workspaceId: ws, status: { not: "APPROVED" } } })).toBe(A.pendingBulk.rows + 1);
    expect(await owner.envelope.count({ where: { workspaceId: ws, status: "PENDING" } })).toBe(A.pendingBulk.rows);
    expect(await owner.envelope.count({ where: { workspaceId: ws, status: "ARCHIVED" } })).toBe(1);
    const audits = await owner.$queryRawUnsafe<Array<{ action: string; n: bigint }>>(
      `SELECT action, count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid GROUP BY action`,
      ws,
    );
    const count = Object.fromEntries(audits.map((a) => [a.action, Number(a.n)]));
    expect(count["envelope.created"]).toBe(A.envelopes.total);
    expect(count["envelope.version.approved"]).toBe(A.approvedVersions);
    expect(count["approval.requested"]).toBeGreaterThan(0);
    expect(count["registry.dimension.created"] ?? count["dimension.created"] ?? 0).toBeGreaterThan(0);
  });

  it("uses more than one approval route (auto-approve, Minor, Standard, Major)", async () => {
    const byPolicy = await owner.$queryRawUnsafe<Array<{ name: string; n: bigint }>>(
      `SELECT p.name, count(*) AS n FROM approval_request r JOIN approval_policy p ON p.id = r.policy_id WHERE r.workspace_id = $1::uuid GROUP BY p.name`,
      golden.workspaceId,
    );
    const names = byPolicy.map((p) => p.name).sort();
    expect(names).toEqual(expect.arrayContaining(["Major / over-allocation", "Minor adjustment", "Standard"]));
    const autos = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'envelope.version.approved' AND reason LIKE 'auto-approved%'`,
      golden.workspaceId,
    );
    expect(Number(autos[0]?.n)).toBeGreaterThan(0);
  });

  it("registry: default dimensions, 3 custom ones (market_tier with an asset: icon), 2 extra templates", async () => {
    const dims = await owner.dimension.findMany({ where: { orgId: golden.orgId }, select: { key: true, icon: true } });
    const keys = dims.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["region", "country", "platform", "objective", "audience", "retailer", "promo_wave", "market_tier"]));
    expect(dims.find((d) => d.key === "market_tier")?.icon).toMatch(/^asset:/);
    const templates = await owner.hierarchyTemplate.findMany({ where: { workspaceId: golden.workspaceId }, select: { name: true } });
    expect(templates.map((t) => t.name).sort()).toEqual(["Channel first", "Default", "Region first"]);
  });
});

describe("pending bulk change (T-013 seed rows)", () => {
  it("is one bulk_change with one open approval request and the asserted totals", async () => {
    const [bulk] = await owner.$queryRawUnsafe<Array<{ id: string; n: number }>>(
      `SELECT id::text AS id, cardinality(version_ids) AS n FROM bulk_change WHERE workspace_id = $1::uuid`,
      golden.workspaceId,
    );
    expect(bulk?.n).toBe(A.pendingBulk.rows);
    const request = await owner.approvalRequest.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, entityType: "bulk_change", entityId: bulk?.id ?? "" } });
    expect(request.status).toBe("PENDING");
    const [sums] = await owner.$queryRawUnsafe<Array<{ after: string; before: string }>>(
      `SELECT sum(v.amount)::text AS after, sum(c.amount)::text AS before
       FROM envelope e JOIN envelope_version v ON v.id = e.draft_version_id JOIN envelope_version c ON c.id = e.current_version_id
       WHERE e.workspace_id = $1::uuid AND v.status = 'PENDING'`,
      golden.workspaceId,
    );
    expect(new Decimal(sums?.before ?? 0).toFixed(2)).toBe(A.pendingBulk.totalsBefore);
    expect(new Decimal(sums?.after ?? 0).toFixed(2)).toBe(A.pendingBulk.totalsAfter);
  });
});

describe("split (T-014 seed rows)", () => {
  it("parts hold the source's approved amount under the same parent; the source is archived at zero with lineage", async () => {
    const sourceId = golden.envelopeIds.get(A.split.sourceKey) as string;
    const source = await owner.envelope.findUniqueOrThrow({ where: { id: sourceId }, include: { versions: { orderBy: { versionNo: "asc" } } } });
    expect(source.status).toBe("ARCHIVED");
    expect(source.versions.at(-1)?.amount.toFixed(2)).toBe("0.00");
    expect(source.versions.at(-1)?.status).toBe("APPROVED");
    const lineage = await owner.envelopeLineage.findMany({ where: { fromEnvelopeId: sourceId, kind: "split" } });
    expect(lineage).toHaveLength(A.split.parts.length);
    for (const part of A.split.parts) {
      const pid = golden.envelopeIds.get(`${A.split.sourceKey}#${part.retailer}`) as string;
      const env = await owner.envelope.findUniqueOrThrow({ where: { id: pid }, include: { versions: true } });
      expect(env.parentId).toBe(source.parentId);
      expect(env.status).toBe("APPROVED");
      expect(env.versions.find((v) => v.id === env.currentVersionId)?.amount.toFixed(2)).toBe(part.amount);
      expect((env.dimensionValues as Record<string, string>)["retailer"]).toBe(part.retailer);
      expect(lineage.map((l) => l.toEnvelopeId)).toContain(pid);
    }
  });
});

describe("facts (T-017 seed rows; done-when: >= 99% match on golden)", () => {
  const F = A.facts;
  it("loads the golden CSV through the pipeline: counts, coverage and the rejected-rows report", async () => {
    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: golden.ingest?.runId ?? "" } });
    expect(run).toMatchObject({ status: "ok", rowsRead: F.rowsRead, rowsRejected: F.rowsRejected, rowsAccepted: F.rowsRead - F.rowsRejected });
    const summary = run.summary as { matchCoverage: string; spendRows: number; matchedSpendRows: number; spend: string; matchedSpend: string };
    expect(summary).toMatchObject({ matchCoverage: F.matchCoverage, spendRows: F.spendRows, matchedSpendRows: F.matchedSpendRows, spend: F.spend, matchedSpend: F.matchedSpend });
    expect(new Decimal(summary.matchCoverage).gte("0.99")).toBe(true);
    expect(summary.matchedSpendRows / summary.spendRows).toBeGreaterThanOrEqual(0.99);
    const report = golden.ingest?.store.objects.get(run.errorReportUri ?? "")?.body ?? "";
    expect(report.trim().split("\n")).toHaveLength(1 + F.rowsRejected);
    expect(report).toContain('unknown platform ""myspace""');
    expect(report).toContain('MONTH ""2026-13"" is not yyyy-MM');
    expect(report).toContain('SPEND_USD ""n/a"" is not a number');
  });

  it("the planner reads the loaded actuals: leaf actual and CPA by region equal the plan's", async () => {
    const q = request({ filter: leaves, groupBy: ["region"], measures: ["actual"], targets: ["cpa", "conversions"] });
    const out = await withTenant(app, ctx(), async (tx) => {
      const c = compileQuery(q, period, TODAY, await plannerOptions(tx, { orgId: golden.orgId, workspaceId: golden.workspaceId }, q.targets, period));
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values);
    });
    const byRegion = Object.fromEntries(out.map((r) => [String(r["dim_region"]), r]));
    for (const [region, actual] of Object.entries(F.leafActualByRegion)) {
      const r = byRegion[region];
      expect(new Decimal(String(r?.["actual"])).toFixed(2)).toBe(actual);
      expect(new Decimal(String(r?.["kpi_conversions"])).toFixed(2)).toBe(F.leafConversionsByRegion[region]);
      expect(new Decimal(String(r?.["kpi_cpa"])).toDecimalPlaces(6).toString()).toBe(new Decimal(actual).div(F.leafConversionsByRegion[region] ?? 1).toDecimalPlaces(6).toString());
    }
  });

  it("queues the unmatched tuple", async () => {
    const groups = await withTenant(app, ctx(), (tx) => unmatchedSpend(tx, golden.workspaceId, 50));
    expect(groups).toHaveLength(F.unmatchedTuples);
    expect(groups[0]).toMatchObject({ dimensionValues: { region: "AMER", country: "US", platform: "meta", objective: "awareness", audience: "prospecting" }, rows: 8, amountReporting: "2000.00" });
  });

  // The same file from the GCS emulator (ADR-011): the report lands in the emulator and the reload changes no totals.
  it.skipIf(!process.env["GCS_EMULATOR_HOST"])("re-runs from the GCS emulator: rejected-rows report in GCS, facts unchanged", async () => {
    const storage = new Storage({ apiEndpoint: process.env["GCS_EMULATOR_HOST"] ?? "", projectId: "budget-os-test" });
    const [exists] = await storage.bucket(uploadBucket()).exists();
    if (!exists) await storage.createBucket(uploadBucket());
    const gcs = new GcsObjectStore(storage);
    const source = await owner.dataSource.findUniqueOrThrow({ where: { id: golden.ingest?.sourceId ?? "" } });
    await gcs.write((source.config as { uri: string }).uri, goldenFactsCsv(goldenPlan()), "text/csv");
    const facts = () => owner.$queryRawUnsafe<Array<{ n: bigint; s: string }>>(`SELECT count(*) AS n, sum(amount_reporting)::text AS s FROM spend_fact WHERE workspace_id = $1::uuid`, golden.workspaceId);
    const before = await facts();
    const admin: AuthContext = {
      ctx: { ...ctx(), userId: golden.users.admin },
      user: { id: golden.users.admin, orgId: golden.orgId, email: "admin@golden.test", name: "Golden admin" },
      isOrgAdmin: false,
      roles: ["WORKSPACE_ADMIN"],
      assignments: [{ role: "WORKSPACE_ADMIN", scope: {} }],
    };
    const { runId } = await queueRun(app, admin, source.id);
    const run = await runIngest({ prisma: app, store: gcs, reportBucket: uploadBucket() }, { workspaceId: golden.workspaceId, orgId: golden.orgId }, runId);
    expect(run).toMatchObject({ rowsRead: F.rowsRead, rowsRejected: F.rowsRejected });
    expect(run.coverage.matchCoverage).toBe(F.matchCoverage);
    const { path } = parseGsUri(run.errorReportUri ?? "");
    const [report] = await storage.bucket(uploadBucket()).file(path).download();
    expect(report.toString().trim().split("\n")).toHaveLength(1 + F.rowsRejected);
    expect(await facts()).toEqual(before);
  });
});

describe("pacing (T-018 seed rows)", () => {
  it("the default rules evaluated on three days leave the planned open alerts, one per rule and envelope", async () => {
    const rules = await owner.pacingRule.findMany({ where: { workspaceId: golden.workspaceId } });
    expect(rules.map((r) => r.name).sort()).toEqual(Object.keys(A.pacing.openAlertsByRule).sort());
    const alerts = await owner.alert.findMany({ where: { workspaceId: golden.workspaceId, status: { in: ["OPEN", "ACKNOWLEDGED", "SNOOZED"] } } });
    const byRule = Object.fromEntries(rules.map((r) => [r.name, alerts.filter((a) => a.ruleId === r.id).length]));
    expect(byRule).toEqual(A.pacing.openAlertsByRule);
    expect(new Set(alerts.map((a) => `${a.ruleId}|${a.envelopeId}`)).size).toBe(alerts.length);
    for (const a of alerts) {
      const rule = rules.find((r) => r.id === a.ruleId);
      expect(new Decimal(a.metricValue.toString()).gt(rule?.threshold.toString() ?? "0")).toBe(true);
    }
    // The 3-day rules opened on the third day; the 1-day rule on the first.
    const openedOn = (name: string) => new Set(alerts.filter((a) => a.ruleId === rules.find((r) => r.name === name)?.id).map((a) => (a.context as { evaluatedFor: string }).evaluatedFor));
    expect([...openedOn("CPA over target")]).toEqual([A.pacing.days[2]]);
    expect([...openedOn("Over-pace")]).toEqual([A.pacing.days[2]]);
    expect([...openedOn("CPA far over target")]).toEqual([A.pacing.days[0]]);
  });
});

describe("threads and tags (T-019 seed rows)", () => {
  const C = A.collab;
  it("seeds the planned threads, comments and tags", async () => {
    const threads = await owner.thread.findMany({ where: { workspaceId: golden.workspaceId }, include: { comments: true } });
    expect({ open: threads.filter((t) => t.status === "open").length, resolved: threads.filter((t) => t.status === "resolved").length, blocking: threads.filter((t) => t.isBlocking && t.status === "open").length }).toEqual(C.threads);
    expect(threads.reduce((n, t) => n + t.comments.length, 0)).toBe(C.comments);
    const mentioned = threads.flatMap((t) => t.comments.flatMap((c) => c.mentions as Array<{ id: string }>)).map((m) => m.id);
    expect(mentioned).toEqual([golden.users.budgetOwner]);
    const tags = await owner.tag.findMany({ where: { workspaceId: golden.workspaceId } });
    const counts = Object.fromEntries(await Promise.all(tags.map(async (t) => [t.name, await owner.taggable.count({ where: { tagId: t.id } })] as const)));
    expect(counts).toEqual(C.tags);
  });

  it("the planner filters on them: tag and has_open_thread", async () => {
    const names = async (filter: FilterGroupT) => (await rows({ filter })).length;
    expect(await names({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: "q4-push" }] })).toBe(C.tags["q4-push"]);
    expect(await names({ logic: "and", children: [{ field: { kind: "attr", key: "has_open_thread" }, op: "eq", value: true }] })).toBe(C.envelopesWithOpenThreads);
  });

  it("the golden blocking thread blocks a submit on its envelope", async () => {
    const t = GOLDEN_COLLAB.threads.find((x) => x.isBlocking);
    const envelopeId = golden.envelopeIds.get(t?.leafKey ?? "") as string;
    const planner: AuthContext = {
      ctx: { ...ctx(), userId: golden.users.planner },
      user: { id: golden.users.planner, orgId: golden.orgId, email: "planner@golden.test", name: "Golden planner" },
      isOrgAdmin: false,
      roles: ["PLANNER"],
      assignments: [{ role: "PLANNER", scope: {} }],
    };
    const head = await owner.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { currentVersionId: true } });
    const draft = await createDraftVersion(app, planner, envelopeId, { amount: "1.00", basedOnVersionId: head.currentVersionId });
    await expect(submitVersion(app, planner, envelopeId, { versionId: draft.id })).rejects.toMatchObject({ code: "CONFLICT", details: { blockingThreads: 1 } });
  });
});

describe("search (T-020 seed rows; done-when: index lag < 5 s on the small golden)", () => {
  const S = A.search;
  const persona = (p: "planner" | "budgetOwner", role: "PLANNER" | "BUDGET_OWNER"): AuthContext => ({
    ctx: { ...ctx(), userId: golden.users[p] },
    user: { id: golden.users[p], orgId: golden.orgId, email: `${p}@golden.test`, name: p },
    isOrgAdmin: false,
    roles: [role],
    assignments: [{ role, scope: {} }],
  });
  const find = async (q: string, who = persona("planner", "PLANNER")) => search(app, who, { q, limit: "50" });
  const count = async (q: string, type: string) => (await find(q)).groups.find((g) => g.type === type)?.count ?? 0;

  it("the seed's re-index holds one document per entity", async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ entity_type: string; n: bigint }>>(`SELECT entity_type, count(*) AS n FROM search_document WHERE workspace_id = $1::uuid GROUP BY entity_type`, golden.workspaceId);
    const counts = Object.fromEntries(rows.map((r) => [r.entity_type, Number(r.n)]));
    const requests = await owner.approvalRequest.count({ where: { workspaceId: golden.workspaceId } });
    expect(counts).toEqual({ ...S, approval_request: requests });
  });

  it("qualifiers and fuzzy text find the planned rows", async () => {
    expect(await count("tag:q4-push type:envelope", "envelope")).toBe(A.collab.tags["q4-push"]);
    const br = goldenPlan().filter((e) => e.dimensionValues["country"] === "BR").length;
    expect(await count("country:br type:envelope", "envelope")).toBe(br);
    expect(await count("status:pending type:approval", "approval_request")).toBe(await owner.approvalRequest.count({ where: { workspaceId: golden.workspaceId, status: "PENDING" } }));
    const fuzzy = (await find("brazl meta awareness")).groups.find((g) => g.type === "envelope")?.hits as Array<{ path: string }>;
    expect(fuzzy[0]?.path).toMatch(/BR › .*meta.*awareness/i);
    // Search counts any open thread on the envelope, cell threads included (the GB blocking thread and
    // the DE October cell thread); the planner's has_open_thread reads envelope-anchored threads only.
    const withThreads = new Set(GOLDEN_COLLAB.threads.filter((t) => !t.resolve).map((t) => t.leafKey)).size;
    expect(await count("has:open-thread type:envelope", "envelope")).toBe(withThreads);
    const mine = await find("mentions:@me", persona("budgetOwner", "BUDGET_OWNER"));
    expect(mine.groups.map((g) => [g.type, g.count])).toEqual([["comment", 1]]);
  });

  it("a change is searchable within 5 s of its commit: command → outbox → indexer → search", async () => {
    const id = golden.envelopeIds.get("LATAM/CO/meta/awareness/retargeting") as string;
    const [{ max }] = (await owner.$queryRawUnsafe<Array<{ max: string | null }>>(`SELECT max(id)::text AS max FROM outbox WHERE workspace_id = $1::uuid`, golden.workspaceId)) as [{ max: string | null }];
    const env = await owner.envelope.findUniqueOrThrow({ where: { id }, select: { rowVersion: true } });
    const name = `Colombia retargeting relaunch ${randomUUID().slice(0, 6)}`;
    const started = performance.now();
    await updateEnvelope(app, persona("planner", "PLANNER"), id, { rowVersion: env.rowVersion, name });
    // What the publisher would push, in outbox order (Pub/Sub transport itself is phase 20).
    const events = await owner.$queryRawUnsafe<Array<{ id: string; topic: string; payload: unknown }>>(`SELECT id::text, topic, payload FROM outbox WHERE workspace_id = $1::uuid AND id > $2::bigint ORDER BY id`, golden.workspaceId, max ?? "0");
    for (const e of events) {
      await handleSearchEvent(app, { message: { data: Buffer.from(JSON.stringify(e.payload)).toString("base64"), attributes: { outboxId: e.id, workspaceId: golden.workspaceId, orgId: golden.orgId, topic: e.topic }, messageId: e.id }, subscription: "search-indexer" }, TODAY);
    }
    const hit = (await find(`"${name}"`)).groups.find((g) => g.type === "envelope")?.hits as Array<{ id: string }> | undefined;
    const lagMs = performance.now() - started;
    expect(hit?.[0]?.id).toBe(id);
    expect(lagMs).toBeLessThan(5_000);
  });
});

describe("targets (T-015 seed rows)", () => {
  it("seeds the metric library and every planned target, each with one approved version", async () => {
    const T = A.targets;
    expect(await owner.metricDefinition.count({ where: { orgId: golden.orgId } })).toBe(11);
    expect(await owner.target.count({ where: { workspaceId: golden.workspaceId, scopeType: "envelope" } })).toBe(T.envelope);
    expect(await owner.target.count({ where: { workspaceId: golden.workspaceId, scopeType: "filter" } })).toBe(T.filter);
    expect(await owner.targetVersion.count({ where: { target: { workspaceId: golden.workspaceId }, status: "APPROVED" } })).toBe(T.envelope + T.filter);
    expect(await owner.target.count({ where: { workspaceId: golden.workspaceId, currentVersionId: null } })).toBe(0);
  });

  it("the planner resolves effective CPA (own or the country's) and the EMEA ROAS filter target on every live leaf", async () => {
    const live: FilterGroupT = { logic: "and", children: [...leaves.children, { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] };
    const q = request({ filter: live, targets: ["cpa", "roas"] });
    const out = await withTenant(app, ctx(), async (tx) => {
      const c = compileQuery(q, period, TODAY, await plannerOptions(tx, { orgId: golden.orgId, workspaceId: golden.workspaceId }, q.targets, period));
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values);
    });
    const regionOf = (r: Record<string, unknown>) => (r["dimension_values"] as Record<string, string>)["region"] as string;
    expect(out).toHaveLength(A.targets.effectiveCpa.leaves);
    expect(out.every((r) => r["tgt_cpa"] !== null)).toBe(true);
    const byRegion: Record<string, string> = {};
    for (const region of Object.keys(A.targets.effectiveCpa.byRegion)) {
      byRegion[region] = out.filter((r) => regionOf(r) === region).reduce((s, r) => s.plus(String(r["tgt_cpa"])), new Decimal(0)).toFixed(2);
    }
    expect(byRegion).toEqual(A.targets.effectiveCpa.byRegion);
    const roas = out.filter((r) => r["tgt_roas"] !== null);
    expect(roas).toHaveLength(A.targets.filterRoasLeaves);
    expect(roas.every((r) => regionOf(r) === "EMEA" && new Decimal(String(r["tgt_roas"])).equals("3.5"))).toBe(true);
  });
});

describe("planner over the golden workspace (phase 9: planner tests read golden.assertions.ts)", () => {
  it("current leaf budget: total and by region, country, platform, objective", async () => {
    expect(await total({ filter: leaves })).toBe(A.leafBudget.current.total);
    expect(await byDim("region")).toEqual(A.leafBudget.current.byRegion);
    expect(await byDim("country")).toEqual(A.leafBudgetCurrent.byCountry);
    expect(await byDim("platform")).toEqual(A.leafBudgetCurrent.byPlatform);
    expect(await byDim("objective")).toEqual(A.leafBudgetCurrent.byObjective);
  });

  it.each(["2026-02-01", "2026-05-01", "2026-08-01"] as const)("as of %s", async (date) => {
    const asOf = `${date}T00:00:00.000Z`;
    expect(await total({ filter: leaves, asOf })).toBe(A.leafBudget[date].total);
    expect(await byDim("region", { asOf })).toEqual(A.leafBudget[date].byRegion);
  });

  it("before the first approval there is no budget", async () => {
    expect(await total({ filter: leaves, asOf: "2026-01-01T00:00:00.000Z" })).toBe("0.00");
  });

  it("region parents hold their approved caps", async () => {
    const regionOnly: FilterGroupT = {
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "not_empty" },
        { field: { kind: "dimension", key: "country" }, op: "is_empty" },
      ],
    };
    const out = await rows({ filter: regionOnly, groupBy: ["region"] });
    const got = Object.fromEntries(out.map((r) => [String(r["dim_region"]), new Decimal(String(r["budget"])).toFixed(2)]));
    expect(got).toEqual(A.parentBudget.byRegion);
    for (const region of Object.keys(A.parentBudget.byRegion)) {
      expect(new Decimal(A.parentBudget.byRegion[region] as string).gte(A.leafBudget.current.byRegion[region] as string)).toBe(true);
    }
  });

  it("current leaf phasing sums to the asserted quarters (and to the leaf total)", async () => {
    const q = await owner.$queryRawUnsafe<Array<{ q: string; s: string }>>(
      `SELECT 'Q' || extract(quarter FROM p.month)::int AS q, sum(p.amount)::text AS s
       FROM envelope e JOIN envelope_dimension ed ON ed.envelope_id = e.id
       JOIN dimension d ON d.id = ed.dimension_id AND d.key = 'audience'
       JOIN envelope_phasing p ON p.version_id = e.current_version_id
       WHERE e.workspace_id = $1::uuid GROUP BY 1 ORDER BY 1`,
      golden.workspaceId,
    );
    const got = Object.fromEntries(q.map((r) => [r.q, new Decimal(r.s).toFixed(2)]));
    expect(got).toEqual(A.leafPhasingByQuarter);
    const sum = Object.values(got).reduce((s, v) => s.plus(v), new Decimal(0));
    expect(sum.toFixed(2)).toBe(A.leafBudget.current.total);
  });
});

// Runs last: its incremental case approves a new budget, which the golden totals above do not include.
describe("rollup tree (T-022 done-when: tree totals == pivot totals on golden)", () => {
  const R = A.rollup;
  const MONEY = ["budget", "actual", "projected"] as const;
  const leavesFilter: FilterGroupT = { logic: "and", children: LIVE_LEAVES };
  const dec = (v: unknown) => new Decimal(String(v ?? 0)).toFixed(2);

  async function tree(templateId: string) {
    const c = compileTree({ workspaceId: golden.workspaceId, templateId, period });
    return withTenant(app, ctx(), (tx) => tx.$queryRawUnsafe<Array<{ node_path: string; depth: number; measures: Record<string, string | null> }>>(c.sql, ...c.values));
  }
  /** The live pivot for one depth: planner groupBy over the same leaves, straight from the facts. */
  async function pivot(path: string[], depth: number): Promise<Map<string, Record<string, string>>> {
    if (depth === 0) {
      const c = compileTotals(request({ filter: leavesFilter, measures: [...MONEY] }), period, TODAY);
      const [t] = await withTenant(app, ctx(), (tx) => tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values));
      return new Map([["", Object.fromEntries(MONEY.map((m) => [m, dec(t?.[m])]))]]);
    }
    const keys = path.slice(0, depth);
    const out = await rows({ filter: leavesFilter, groupBy: keys, measures: [...MONEY] });
    return new Map(out.map((r) => [keys.map((k) => (r[`dim_${k}`] === null ? "∅" : String(r[`dim_${k}`]))).join("/"), Object.fromEntries(MONEY.map((m) => [m, dec(r[m])]))]));
  }
  async function assertTreeEqualsPivot() {
    const templates = await owner.hierarchyTemplate.findMany({ where: { workspaceId: golden.workspaceId } });
    expect(templates.map((t) => t.name).sort()).toEqual(Object.keys(R.nodesByTemplate).sort());
    for (const t of templates) {
      const nodes = await tree(t.id);
      const byDepth = t.path.map((_, d) => nodes.filter((n) => Number(n.depth) === d + 1).length);
      expect([nodes.filter((n) => Number(n.depth) === 0).length, ...byDepth], t.name).toEqual(R.nodesByTemplate[t.name]);
      for (let d = 0; d <= t.path.length; d += 1) {
        const live = await pivot(t.path, d);
        const cached = new Map(nodes.filter((n) => Number(n.depth) === d).map((n) => [n.node_path, Object.fromEntries(MONEY.map((m) => [m, dec(n.measures[m])]))]));
        expect(cached, `${t.name} depth ${d}`).toEqual(live);
      }
    }
  }

  it("every cached node of every template equals the live pivot; the root equals the pivot totals", async () => {
    await assertTreeEqualsPivot();
    const regionFirst = await owner.hierarchyTemplate.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, name: "Region first" } });
    const root = (await tree(regionFirst.id)).find((n) => n.node_path === "");
    expect({ budget: dec(root?.measures["budget"]), actual: dec(root?.measures["actual"]) }).toEqual({ budget: R.rootBudget, actual: R.rootActual });
  });

  it("an approved change reaches the cache through the rollup handler, and the tree still equals the pivot", async () => {
    const key = "LATAM/AR/meta/awareness/prospecting";
    const id = golden.envelopeIds.get(key) as string;
    const planner: AuthContext = { ctx: { ...ctx(), userId: golden.users.planner }, user: { id: golden.users.planner, orgId: golden.orgId, email: "planner@golden.test", name: "planner" }, isOrgAdmin: false, roles: ["PLANNER"], assignments: [{ role: "PLANNER", scope: {} }] };
    const [{ max }] = (await owner.$queryRawUnsafe<Array<{ max: string | null }>>(`SELECT max(id)::text AS max FROM outbox WHERE workspace_id = $1::uuid`, golden.workspaceId)) as [{ max: string | null }];
    const head = await owner.envelope.findUniqueOrThrow({ where: { id }, include: { versions: { where: { status: "APPROVED" } } } });
    const current = new Decimal(head.versions[0]?.amount.toString() ?? 0);
    const next = current.plus("10.00").toFixed(2); // under the auto-approve policy (< 2 %, < 1000)
    const draft = await createDraftVersion(app, planner, id, { amount: next, basedOnVersionId: head.currentVersionId });
    const submitted = await submitVersion(app, planner, id, { versionId: draft.id });
    expect(submitted.autoApproved).toBe(true);
    const events = await owner.$queryRawUnsafe<Array<{ id: string; topic: string; payload: unknown }>>(`SELECT id::text, topic, payload FROM outbox WHERE workspace_id = $1::uuid AND id > $2::bigint ORDER BY id`, golden.workspaceId, max ?? "0");
    for (const e of events) {
      await handleRollupEvent(app, { message: { data: Buffer.from(JSON.stringify(e.payload)).toString("base64"), attributes: { outboxId: e.id, workspaceId: golden.workspaceId, orgId: golden.orgId, topic: e.topic }, messageId: e.id }, subscription: "rollup-worker" }, TODAY);
    }
    await assertTreeEqualsPivot();
    const regionFirst = await owner.hierarchyTemplate.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, name: "Region first" } });
    const root = (await tree(regionFirst.id)).find((n) => n.node_path === "");
    expect(dec(root?.measures["budget"])).toBe(new Decimal(R.rootBudget).plus("10.00").toFixed(2));
  });
});
