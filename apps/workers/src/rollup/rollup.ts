import { LIVE_LEAVES, QueryRequest, elapsedFraction, groupRatios, resolvePeriod, type FilterGroupT, type Predicate } from "@budget/domain";
import { cachedPeriods, deleteRollupNodes, deleteRollupNodesExcept, envelopesByTuple, envelopesUnderPrefixes, hasProjections, lockRollup, recomputeNames, rollupChildren, upsertRollupNodes, withTenant, type RollupNode, type TenantContext, type Tx, fiscalCalendar } from "@budget/db";
import { NONE_SEGMENT, ROOT_PATH, compileQuery, compileTotals, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { HierarchyTemplate, PrismaClient } from "@prisma/client";
import { decodePush, handleOnce } from "../consumer.js";
import { log } from "../log.js";
import { targetsFor } from "../search-indexer/indexer.js";

/**
 * rollup-worker (spec §19, plan §5.3): rollup_cache holds each hierarchy template's tree for a
 * period, so the grid reads roll-ups instead of computing them. Node measures come from the
 * planner itself — `groupBy` = the template path up to the node's depth over the live leaf
 * envelopes — so the cached tree and a live pivot always agree. A change recomputes only the nodes
 * on its envelopes' paths; registry changes rebuild every template.
 */

export const ROLLUP_CONSUMER = "rollup-worker";
type Row = Record<string, unknown>;

export { LIVE_LEAVES } from "@budget/domain";

interface Ctx {
  workspaceId: string;
  orgId: string;
  today: string;
}
type Period = { start: string; end: string };

const SUMS = ["budget", "actual", "projected", "remaining", "variance_abs"] as const;
const segment = (v: unknown) => (v === null || v === undefined ? NONE_SEGMENT : String(v));
const depthOf = (path: string) => (path === ROOT_PATH ? 0 : path.split("/").length);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT_PATH);

/**
 * A node's additive parts. Every level of a template partitions the same live leaves (a missing
 * dimension is its own ∅ node), so a parent is exactly the sum of its children: only the deepest
 * level is read through the planner, everything above is summed here (ADR-038). A sum over no
 * non-null value stays null, as SQL's sum() does.
 */
interface Sums {
  budget: Decimal | null;
  actual: Decimal | null;
  projected: Decimal | null;
  remaining: Decimal | null;
  variance_abs: Decimal | null;
  leafCount: number;
  pendingCount: number;
}
const zero = (): Sums => ({ budget: null, actual: null, projected: null, remaining: null, variance_abs: null, leafCount: 0, pendingCount: 0 });
const dec = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)));
const plus = (a: Decimal | null, b: Decimal | null) => (a === null ? b : b === null ? a : a.plus(b));
function add(into: Sums, x: Sums): void {
  for (const k of SUMS) into[k] = plus(into[k], x[k]);
  into.leafCount += x.leafCount;
  into.pendingCount += x.pendingCount;
}
const sumsOfRow = (r: Row): Sums => ({ budget: dec(r["budget"]), actual: dec(r["actual"]), projected: dec(r["projected"]), remaining: dec(r["remaining"]), variance_abs: dec(r["variance_abs"]), leafCount: Number(r["leaf_count"] ?? 0), pendingCount: Number(r["pending_count"] ?? 0) });
const sumsOfCached = (m: Record<string, unknown>): Sums => ({ budget: dec(m["budget"]), actual: dec(m["actual"]), projected: dec(m["projected"]), remaining: dec(m["remaining"]), variance_abs: dec(m["variance_abs"]), leafCount: Number(m["leafCount"] ?? 0), pendingCount: Number(m["pendingCount"] ?? 0) });

/** Stored measures: money as NUMERIC(18,2) strings; ratios recomputed from the sums, never averaged. */
function measuresOf(x: Sums, frac: Decimal): RollupNode["measures"] {
  const money = (v: Decimal | null) => (v === null ? null : v.toFixed(2));
  return {
    budget: money(x.budget),
    actual: money(x.actual),
    projected: money(x.projected),
    remaining: money(x.remaining),
    variance_abs: money(x.variance_abs),
    ...groupRatios(x, frac),
    leafCount: x.leafCount,
    pendingCount: x.pendingCount,
  };
}

/** Prefix predicates for one node: eq on each key's code, is_empty where the segment is ∅. */
function prefixFilter(keys: string[], segments: string[]): FilterGroupT {
  return {
    logic: "and",
    children: keys.map((key, i): Predicate => (segments[i] === NONE_SEGMENT ? { field: { kind: "dimension", key }, op: "is_empty" } : { field: { kind: "dimension", key }, op: "eq", value: segments[i] as string })),
  };
}

/** Nodes at `depth` (≥ 1) of a template through the planner, optionally only those under the given prefixes. */
async function nodesAtDepth(tx: Tx, ctx: Ctx, path: string[], depth: number, period: Period, only: string[][] | null): Promise<Array<{ nodePath: string; sums: Sums }>> {
  const keys = path.slice(0, depth);
  const children: Array<Predicate | FilterGroupT> = [...LIVE_LEAVES];
  if (only !== null) {
    if (only.length === 0) return [];
    children.push({ logic: "or", children: only.map((segs) => prefixFilter(keys, segs)) });
  }
  const out: Array<{ nodePath: string; sums: Sums }> = [];
  // Under given prefixes: their envelopes first, so the planner starts from a known set (ADR-038).
  const ids = only === null ? undefined : await envelopesUnderPrefixes(tx, ctx, keys, only, NONE_SEGMENT);
  if (ids !== undefined && ids.length === 0) return [];
  const opts = { hasProjections: await hasProjections(tx, ctx.workspaceId), ...(ids === undefined ? {} : { envelopeIds: ids }) };
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId: ctx.workspaceId, filter: { logic: "and", children }, groupBy: keys, measures: [...SUMS], period: { kind: "range", ...period }, limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, period, ctx.today, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
    for (const r of page.rows) out.push({ nodePath: keys.map((k) => segment(r[`dim_${k.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`])).join("/"), sums: sumsOfRow(r) });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function rootSums(tx: Tx, ctx: Ctx, period: Period): Promise<Sums> {
  const q = QueryRequest.parse({ workspaceId: ctx.workspaceId, filter: { logic: "and", children: LIVE_LEAVES }, measures: [...SUMS], period: { kind: "range", ...period }, limit: 1 });
  const c = compileTotals(q, period, ctx.today);
  const [t] = await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values);
  return sumsOfRow(t ?? {});
}

/**
 * The envelope that *is* each node: the one live envelope whose tuple is exactly the node's
 * segments for the template's first keys (none when two share it, or it has no ∅-free tuple).
 */
async function nodeEnvelopes(tx: Tx, workspaceId: string, path: string[], nodePaths: string[]): Promise<Map<string, string>> {
  const tuples: Array<Record<string, string>> = [];
  const byTuple: string[] = [];
  for (const p of nodePaths) {
    if (p === ROOT_PATH) continue;
    const segs = p.split("/");
    if (segs.includes(NONE_SEGMENT)) continue;
    tuples.push(Object.fromEntries(segs.map((sg, i) => [path[i] as string, sg])));
    byTuple.push(p);
  }
  const hits = new Map<string, string[]>();
  for (const h of await envelopesByTuple(tx, workspaceId, tuples)) {
    const p = byTuple[h.i] as string;
    hits.set(p, [...(hits.get(p) ?? []), h.id]);
  }
  return new Map([...hits].filter(([, ids]) => ids.length === 1).map(([p, ids]) => [p, ids[0] as string]));
}

const dataVersionOf = async (tx: Tx, workspaceId: string) => {
  const w = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  return Number(((w.settings ?? {}) as { dataVersion?: number }).dataVersion ?? 0);
};

/**
 * Every node of a template for a period (root first, then each depth), not stored. The deepest
 * level comes from the planner; each level above is the sum of the one below. Also used by closures (T-024).
 */
export async function templateNodes(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "path">, period: Period): Promise<RollupNode[]> {
  const depth = template.path.length;
  const sums = new Map<string, Sums>([[ROOT_PATH, zero()]]);
  if (depth === 0) sums.set(ROOT_PATH, await rootSums(tx, ctx, period));
  else {
    for (const n of await nodesAtDepth(tx, ctx, template.path, depth, period, null)) {
      const segs = n.nodePath.split("/");
      for (let d = 0; d <= depth; d += 1) {
        const p = segs.slice(0, d).join("/");
        const acc = sums.get(p) ?? zero();
        add(acc, n.sums);
        sums.set(p, acc);
      }
    }
  }
  const paths = [...sums.keys()].sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  const envelopeOf = await nodeEnvelopes(tx, ctx.workspaceId, template.path, paths);
  const frac = elapsedFraction(period, ctx.today);
  return paths.map((p) => ({ nodePath: p, envelopeId: envelopeOf.get(p) ?? null, measures: measuresOf(sums.get(p) as Sums, frac) }));
}

export async function buildTemplate(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "id" | "path">, period: Period): Promise<number> {
  const scope = { workspaceId: ctx.workspaceId, templateId: template.id, periodStart: period.start, periodEnd: period.end, dataVersion: await dataVersionOf(tx, ctx.workspaceId) };
  const nodes = await templateNodes(tx, ctx, template, period);
  for (let i = 0; i < nodes.length; i += 1000) await upsertRollupNodes(tx, scope, nodes.slice(i, i + 1000));
  await deleteRollupNodesExcept(tx, scope, nodes.map((n) => n.nodePath));
  return nodes.length;
}

/**
 * Recomputes the nodes on the paths of the given envelopes: their deepest nodes through the
 * planner, then each ancestor (up to the root) as the sum of its cached children. Nodes left
 * empty are deleted; the root always stays.
 */
export async function refreshTemplate(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "id" | "path">, period: Period, envelopeIds: string[]): Promise<{ upserted: number; deleted: number }> {
  const envs = await tx.envelope.findMany({ where: { id: { in: envelopeIds } }, select: { dimensionValues: true } });
  const scope = { workspaceId: ctx.workspaceId, templateId: template.id, periodStart: period.start, periodEnd: period.end, dataVersion: await dataVersionOf(tx, ctx.workspaceId) };
  const depth = template.path.length;
  const frac = elapsedFraction(period, ctx.today);
  if (depth === 0) {
    return { upserted: await upsertRollupNodes(tx, scope, [{ nodePath: ROOT_PATH, envelopeId: null, measures: measuresOf(await rootSums(tx, ctx, period), frac) }]), deleted: 0 };
  }
  const deepest = new Map<string, string[]>();
  for (const e of envs) {
    const dims = e.dimensionValues as Record<string, string>;
    const segs = template.path.map((k) => segment(dims[k]));
    deepest.set(segs.join("/"), segs);
  }
  const found = new Map((await nodesAtDepth(tx, ctx, template.path, depth, period, [...deepest.values()])).map((n) => [n.nodePath, n.sums]));
  const touched = new Set<string>(deepest.keys());
  for (const p of deepest.keys()) for (let q = parentOf(p); ; q = parentOf(q)) {
    touched.add(q);
    if (q === ROOT_PATH) break;
  }
  const envelopeOf = await nodeEnvelopes(tx, ctx.workspaceId, template.path, [...touched]);
  const upserts: RollupNode[] = [];
  const gone: string[] = [];
  for (const [p, x] of found) upserts.push({ nodePath: p, envelopeId: envelopeOf.get(p) ?? null, measures: measuresOf(x, frac) });
  for (const p of deepest.keys()) if (!found.has(p)) gone.push(p);
  let upserted = await upsertRollupNodes(tx, scope, upserts);
  let deleted = await deleteRollupNodes(tx, scope, gone);
  // Ancestors, deepest first: each is the sum of its children as now cached.
  for (let d = depth - 1; d >= 0; d -= 1) {
    const parents = [...touched].filter((p) => depthOf(p) === d);
    const sums = new Map<string, Sums>(parents.map((p) => [p, zero()]));
    const counted = new Set<string>();
    for (const c of await rollupChildren(tx, scope, parents, d + 1)) {
      const p = parentOf(c.nodePath);
      counted.add(p);
      add(sums.get(p) ?? zero(), sumsOfCached(c.measures));
    }
    const level: RollupNode[] = [];
    const empty: string[] = [];
    for (const p of parents) {
      if (p !== ROOT_PATH && !counted.has(p)) empty.push(p);
      else level.push({ nodePath: p, envelopeId: envelopeOf.get(p) ?? null, measures: measuresOf(sums.get(p) as Sums, frac) });
    }
    upserted += await upsertRollupNodes(tx, scope, level);
    deleted += await deleteRollupNodes(tx, scope, empty);
  }
  return { upserted, deleted };
}

const system = (tenant: { workspaceId: string; orgId: string }, requestId: string): TenantContext => ({ ...tenant, userId: null, isOrgAdmin: false, actorType: "system", requestId });

async function periodsFor(tx: Tx, ctx: Ctx, templateId: string, extra: Period[]): Promise<Period[]> {
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { fiscalYearStartMonth: true } });
  // The fiscal year and quarter the Explorer opens on (ADR-038); other periods are cached once built.
  const calendar = await fiscalCalendar(tx, ctx.workspaceId);
  const year = resolvePeriod({ kind: "relative", preset: "current_year" }, ctx.today, ws.fiscalYearStartMonth, calendar);
  const quarter = resolvePeriod({ kind: "relative", preset: "current_quarter" }, ctx.today, ws.fiscalYearStartMonth, calendar);
  const all = [year, quarter, ...extra, ...(await cachedPeriods(tx, ctx.workspaceId, templateId))];
  return [...new Map(all.map((p) => [`${p.start}|${p.end}`, p])).values()];
}

/** Rebuilds every template of the workspace for the current fiscal year, the cached periods and `periods`. */
export async function rebuildWorkspace(prisma: PrismaClient, tenant: { workspaceId: string; orgId: string }, opts: { today?: string; periods?: Period[] } = {}): Promise<Record<string, number>> {
  const ctx: Ctx = { ...tenant, today: opts.today ?? new Date().toISOString().slice(0, 10) };
  const counts: Record<string, number> = {};
  const templates = await withTenant(prisma, system(tenant, `rollup-list-${tenant.workspaceId}`), (tx) => tx.hierarchyTemplate.findMany({ where: { workspaceId: tenant.workspaceId }, orderBy: { name: "asc" } }));
  for (const t of templates) {
    await withTenant(
      prisma,
      system(tenant, `rollup-${t.id}`),
      async (tx) => {
        await lockRollup(tx, tenant.workspaceId);
        for (const p of await periodsFor(tx, ctx, t.id, opts.periods ?? [])) counts[`${t.name}|${p.start}|${p.end}`] = await buildTemplate(tx, ctx, t, p);
      },
      { timeoutMs: 300_000 },
    );
  }
  log.info({ workspaceId: tenant.workspaceId, counts }, "rollup rebuilt");
  return counts;
}

/** Push handler for budget.changed, facts.loaded and registry.changed; once per outbox id. */
export async function handleRollupEvent(prisma: PrismaClient, body: unknown, today = new Date().toISOString().slice(0, 10)) {
  const event = decodePush(body);
  const ctx: Ctx = { workspaceId: event.workspaceId, orgId: event.orgId, today };
  let result: { templates: number; upserted: number; deleted: number; rebuilt: boolean; renamed?: number } = { templates: 0, upserted: 0, deleted: 0, rebuilt: false };
  const outcome = await handleOnce(prisma, ROLLUP_CONSUMER, event, async (tx) => {
    await lockRollup(tx, event.workspaceId);
    // T-036 (§24.2): a naming or registry change renames every envelope (labels, codes, templates).
    if (event.topic === "naming.changed" || event.topic === "registry.changed") result.renamed = await recomputeNames(tx, event.workspaceId);
    if (!["budget.changed", "facts.loaded", "registry.changed"].includes(event.topic)) return;
    const templates = await tx.hierarchyTemplate.findMany({ where: { workspaceId: event.workspaceId } });
    result.templates = templates.length;
    if (event.topic === "registry.changed") {
      // Values merged or re-parented, templates saved: rebuild (spec §19).
      for (const t of templates) for (const p of await periodsFor(tx, ctx, t.id, [])) result.upserted += await buildTemplate(tx, ctx, t, p);
      result = { ...result, rebuilt: true };
      return;
    }
    const envelopeIds = (await targetsFor(tx, event.topic, (event.payload ?? {}) as Record<string, unknown>)).envelope ?? [];
    if (envelopeIds.length === 0) return;
    for (const t of templates) {
      for (const p of await periodsFor(tx, ctx, t.id, [])) {
        const r = await refreshTemplate(tx, ctx, t, p, envelopeIds);
        result.upserted += r.upserted;
        result.deleted += r.deleted;
      }
    }
  });
  return { outcome, ...result };
}
