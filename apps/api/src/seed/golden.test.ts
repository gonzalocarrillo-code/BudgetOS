import { randomUUID } from "node:crypto";
import { QueryRequest, type FilterGroupT } from "@budget/domain";
import { GOLDEN_ASSERTIONS, GOLDEN_FY, computeTotals, goldenPlan, withTenant, type TenantContext } from "@budget/db";
import { compileQuery, compileTotals } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb as appDbClient, ownerDb } from "../test-support/harness.js";
import { seedGolden, type GoldenResult } from "./golden.js";
import { cleanupGolden } from "../test-support/golden-cleanup.js";
import { plannerOptions } from "../modules/targets/queries/planner-options.js";

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
