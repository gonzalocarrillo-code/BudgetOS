import { LIVE_LEAVES, QueryRequest, resolvePeriod, type FilterGroupT, type Predicate } from "@budget/domain";
import { cachedPeriods, deleteRollupNodes, deleteRollupNodesExcept, recomputeNames, upsertRollupNodes, withTenant, type RollupNode, type TenantContext, type Tx } from "@budget/db";
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
const MEASURES = ["budget", "actual", "projected", "remaining", "pace_index", "spend_to_date_pct", "projected_close_pct"] as const;
type Row = Record<string, unknown>;

export { LIVE_LEAVES } from "@budget/domain";

interface Ctx {
  workspaceId: string;
  orgId: string;
  today: string;
}
type Period = { start: string; end: string };

const MONEY = new Set(["budget", "actual", "projected", "remaining"]);
/** Money as NUMERIC(18,2) strings, ratios at their computed precision. */
const value = (k: string, v: unknown) => (v === null || v === undefined ? null : MONEY.has(k) ? new Decimal(String(v)).toFixed(2) : new Decimal(String(v)).toString());
const segment = (v: unknown) => (v === null || v === undefined ? NONE_SEGMENT : String(v));

/** Prefix predicates for one node: eq on each key's code, is_empty where the segment is ∅. */
function prefixFilter(keys: string[], segments: string[]): FilterGroupT {
  return {
    logic: "and",
    children: keys.map((key, i): Predicate => (segments[i] === NONE_SEGMENT ? { field: { kind: "dimension", key }, op: "is_empty" } : { field: { kind: "dimension", key }, op: "eq", value: segments[i] as string })),
  };
}

function measuresOf(r: Row): RollupNode["measures"] {
  const m: RollupNode["measures"] = {};
  for (const k of MEASURES) m[k] = value(k, r[k]);
  m["leafCount"] = Number(r["leaf_count"] ?? 0);
  if (r["pending_count"] !== undefined) m["pendingCount"] = Number(r["pending_count"]);
  return m;
}

/** Nodes at `depth` (≥ 1) of a template, optionally only those under the given prefixes. */
async function nodesAtDepth(tx: Tx, ctx: Ctx, path: string[], depth: number, period: Period, only: string[][] | null): Promise<Array<{ nodePath: string; segments: string[]; measures: RollupNode["measures"] }>> {
  const keys = path.slice(0, depth);
  const children: Array<Predicate | FilterGroupT> = [...LIVE_LEAVES];
  if (only !== null) {
    if (only.length === 0) return [];
    children.push({ logic: "or", children: only.map((segs) => prefixFilter(keys, segs)) });
  }
  const out: Array<{ nodePath: string; segments: string[]; measures: RollupNode["measures"] }> = [];
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId: ctx.workspaceId, filter: { logic: "and", children }, groupBy: keys, measures: [...MEASURES], period: { kind: "range", ...period }, limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, period, ctx.today);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
    for (const r of page.rows) {
      const segments = keys.map((k) => segment(r[`dim_${k.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`]));
      out.push({ nodePath: segments.join("/"), segments, measures: measuresOf(r) });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function rootNode(tx: Tx, ctx: Ctx, period: Period): Promise<RollupNode["measures"]> {
  const q = QueryRequest.parse({ workspaceId: ctx.workspaceId, filter: { logic: "and", children: LIVE_LEAVES }, measures: [...MEASURES], period: { kind: "range", ...period }, limit: 1 });
  const c = compileTotals(q, period, ctx.today);
  const [t] = await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values);
  return measuresOf(t ?? {});
}

/** The envelope that *is* a node: its tuple is exactly the node's segments for the template keys (when there is one). */
async function nodeEnvelopes(tx: Tx, workspaceId: string, path: string[]): Promise<Map<string, string>> {
  const envs = await tx.envelope.findMany({ where: { workspaceId, status: { not: "ARCHIVED" } }, select: { id: true, dimensionValues: true } });
  const counts = new Map<string, { id: string; n: number }>();
  for (const e of envs) {
    const dims = e.dimensionValues as Record<string, string>;
    const keys = Object.keys(dims);
    const depth = keys.length;
    if (depth === 0 || depth > path.length || !path.slice(0, depth).every((k) => k in dims)) continue;
    const key = path.slice(0, depth).map((k) => dims[k]).join("/");
    const hit = counts.get(key);
    counts.set(key, { id: e.id, n: (hit?.n ?? 0) + 1 });
  }
  return new Map([...counts].filter(([, v]) => v.n === 1).map(([k, v]) => [k, v.id]));
}

const dataVersionOf = async (tx: Tx, workspaceId: string) => {
  const w = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  return Number(((w.settings ?? {}) as { dataVersion?: number }).dataVersion ?? 0);
};

/** Full build of one template for one period: every depth, and nodes no longer present are removed. */
/** Every node of a template for a period (root first, then each depth), computed by the planner, not stored. Also used by closures (T-024). */
export async function templateNodes(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "path">, period: Period): Promise<RollupNode[]> {
  const envelopeOf = await nodeEnvelopes(tx, ctx.workspaceId, template.path);
  const nodes: RollupNode[] = [{ nodePath: ROOT_PATH, envelopeId: null, measures: await rootNode(tx, ctx, period) }];
  for (let d = 1; d <= template.path.length; d += 1) {
    for (const n of await nodesAtDepth(tx, ctx, template.path, d, period, null)) nodes.push({ nodePath: n.nodePath, envelopeId: envelopeOf.get(n.nodePath) ?? null, measures: n.measures });
  }
  return nodes;
}

export async function buildTemplate(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "id" | "path">, period: Period): Promise<number> {
  const scope = { workspaceId: ctx.workspaceId, templateId: template.id, periodStart: period.start, periodEnd: period.end, dataVersion: await dataVersionOf(tx, ctx.workspaceId) };
  const nodes = await templateNodes(tx, ctx, template, period);
  for (let i = 0; i < nodes.length; i += 1000) await upsertRollupNodes(tx, scope, nodes.slice(i, i + 1000));
  await deleteRollupNodesExcept(tx, scope, nodes.map((n) => n.nodePath));
  return nodes.length;
}

/** Recomputes the nodes on the paths of the given envelopes (and the root); empty nodes are deleted. */
export async function refreshTemplate(tx: Tx, ctx: Ctx, template: Pick<HierarchyTemplate, "id" | "path">, period: Period, envelopeIds: string[]): Promise<{ upserted: number; deleted: number }> {
  const envs = await tx.envelope.findMany({ where: { id: { in: envelopeIds } }, select: { dimensionValues: true } });
  const scope = { workspaceId: ctx.workspaceId, templateId: template.id, periodStart: period.start, periodEnd: period.end, dataVersion: await dataVersionOf(tx, ctx.workspaceId) };
  const envelopeOf = await nodeEnvelopes(tx, ctx.workspaceId, template.path);
  const upserts: RollupNode[] = [{ nodePath: ROOT_PATH, envelopeId: null, measures: await rootNode(tx, ctx, period) }];
  const gone: string[] = [];
  for (let d = 1; d <= template.path.length; d += 1) {
    const prefixes = new Map<string, string[]>();
    for (const e of envs) {
      const dims = e.dimensionValues as Record<string, string>;
      const segs = template.path.slice(0, d).map((k) => segment(dims[k]));
      prefixes.set(segs.join("/"), segs);
    }
    const found = await nodesAtDepth(tx, ctx, template.path, d, period, [...prefixes.values()]);
    for (const n of found) upserts.push({ nodePath: n.nodePath, envelopeId: envelopeOf.get(n.nodePath) ?? null, measures: n.measures });
    for (const p of prefixes.keys()) if (!found.some((n) => n.nodePath === p)) gone.push(p);
  }
  return { upserted: await upsertRollupNodes(tx, scope, upserts), deleted: await deleteRollupNodes(tx, scope, gone) };
}

const system = (tenant: { workspaceId: string; orgId: string }, requestId: string): TenantContext => ({ ...tenant, userId: null, isOrgAdmin: false, actorType: "system", requestId });

async function periodsFor(tx: Tx, ctx: Ctx, templateId: string, extra: Period[]): Promise<Period[]> {
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { fiscalYearStartMonth: true } });
  const current = resolvePeriod({ kind: "relative", preset: "current_year" }, ctx.today, ws.fiscalYearStartMonth);
  const all = [current, ...extra, ...(await cachedPeriods(tx, ctx.workspaceId, templateId))];
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
