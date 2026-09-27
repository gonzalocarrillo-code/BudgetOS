import { DomainError, QueryRequest, readScopeFilter, resolvePeriod, type FilterGroupT, type QueryResponse } from "@budget/domain";
import { envelopePaths, envelopesByTuple, plannerOptions, withTenant, fiscalCalendar } from "@budget/db";
import { aggregateSupported, bigQuerySupported, compileAggregate, compileAggregateBq, compileAggregateTotals, compileAggregateTotalsBq, compileQuery, compileTotals, pageOf, sanitize } from "@budget/query-planner";
import { HEAVY_MONTHS, HEAVY_ROWS, QUERY_CACHE_TTL_SECONDS, cacheKey, engineFromEnv, maxPlanRows, monthsSpanned, type QueryEngine } from "./engine.js";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * A QueryRequest through the planner (spec §6) as the caller may see it: their read scope is
 * ANDed into the filter (same rule as exports, ADR-017), then one page, the totals and the data
 * version. Used by the MCP `query_budgets` tool; the `/query` route arrives with T-027.
 */

type Row = Record<string, unknown>;
const MONEY = new Set(["budget", "actual", "projected", "remaining", "variance_abs"]);
const measure = (k: string, v: unknown) => (v === null || v === undefined ? null : MONEY.has(k) ? new Decimal(String(v)).toFixed(2) : String(v));
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function scopedQuery(auth: AuthContext, raw: unknown): QueryRequest {
  const q = parseInput(QueryRequest, raw);
  if (q.workspaceId !== requireWorkspace(auth.ctx.workspaceId)) throw new DomainError("VALIDATION", "query.workspaceId must be the caller's workspace");
  const scope = auth.isOrgAdmin ? null : readScopeFilter(auth.assignments, "envelope.read");
  const filter: FilterGroupT | undefined = scope === null ? q.filter : q.filter ? { logic: "and", children: [q.filter, scope] } : scope;
  return { ...q, ...(filter ? { filter } : {}) };
}

export async function runQuery(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date(), engine: QueryEngine = engineFromEnv()): Promise<QueryResponse> {
  const started = performance.now();
  const q = scopedQuery(auth, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: q.workspaceId }, select: { fiscalYearStartMonth: true, settings: true } });
    const today = now.toISOString().slice(0, 10);
    const period = resolvePeriod(q.period, today, ws.fiscalYearStartMonth, await fiscalCalendar(tx, q.workspaceId));
    const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId: q.workspaceId }, q.targets, period);
    const dataVersion = Number((ws.settings as { dataVersion?: number } | null)?.dataVersion ?? 0);
    const key = engine.cache ? cacheKey(q, dataVersion, today) : null;
    if (key && engine.cache) {
      const hit = await engine.cache.get(key);
      if (hit) return { ...(JSON.parse(hit) as QueryResponse), engine: "cache" as const, elapsedMs: Math.round(performance.now() - started) };
    }
    const grouped = q.groupBy.length > 0;
    // Heavy shapes (grouped rows, totals) run set-based when the filter allows it (ADR-042): the
    // same answer, one pass over the facts instead of one subquery per envelope — on the warehouse
    // replica when one is configured and the query is heavy (spec §6.2), else on Postgres.
    const setBased = aggregateSupported(q, opts);
    const c = setBased && grouped ? compileAggregate(q, period, today, opts) : compileQuery(q, period, today, opts);
    const heavy = async () => {
      if (monthsSpanned(period) > HEAVY_MONTHS) return true;
      const [plan] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(`EXPLAIN (FORMAT JSON) ${c.sql}`, ...c.values);
      return maxPlanRows(plan?.["QUERY PLAN"]) > HEAVY_ROWS;
    };
    const warehouse = engine.warehouse && grouped && bigQuerySupported(q, opts) && (await heavy()) ? engine.warehouse : null;
    let page: { rows: Row[]; nextCursor: string | null };
    let totals: Row | undefined;
    if (warehouse) {
      const w = compileAggregateBq(q, period, today, warehouse.dataset, opts);
      page = pageOf({ sql: w.sql, values: [], orderKeys: w.orderKeys }, await warehouse.query(w.sql, w.params, w.types), q.limit);
      const wt = compileAggregateTotalsBq(q, period, today, warehouse.dataset, opts);
      [totals] = await warehouse.query(wt.sql, wt.params, wt.types);
    } else {
      page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
      const t = setBased ? compileAggregateTotals(q, period, today, opts) : compileTotals(q, period, today, opts);
      [totals] = await tx.$queryRawUnsafe<Row[]>(t.sql, ...t.values);
    }
    const paths = grouped ? new Map<string, string[]>() : await envelopePaths(tx, page.rows.map((r) => String(r["envelope_id"])));
    const measures = [...new Set(q.measures)];
    // Group rows: the envelope whose tuple is exactly the group's (a parent), when there is one.
    const nodeOf = new Map<number, string>();
    if (grouped) {
      // Only groups with a value for every key can be an envelope's exact tuple.
      const tuples: Array<Record<string, string>> = [];
      const rowOf: number[] = [];
      page.rows.forEach((r, i) => {
        // Leading keys with no value are "above" the group (e.g. no client): skip them, as the cache does.
        const values = q.groupBy.map((k) => text(r[`dim_${sanitize(k)}`]));
        const first = values.findIndex((v) => v !== null);
        if (first < 0 || values.slice(first).some((v) => v === null)) return;
        tuples.push(Object.fromEntries(q.groupBy.slice(first).map((k, j) => [k, values[first + j] as string])));
        rowOf.push(i);
      });
      const hits = new Map<number, string[]>();
      for (const h of await envelopesByTuple(tx, q.workspaceId, tuples)) {
        const i = rowOf[h.i] as number;
        hits.set(i, [...(hits.get(i) ?? []), h.id]);
      }
      for (const [i, ids] of hits) if (ids.length === 1) nodeOf.set(i, ids[0] as string);
    }
    const rows = page.rows.map((r, index) => {
      const dims: Record<string, string | null> = grouped
        ? Object.fromEntries(q.groupBy.map((k) => [k, text(r[`dim_${sanitize(k)}`])]))
        : Object.fromEntries(Object.entries((r["dimension_values"] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, text(v)]));
      const id = grouped ? null : String(r["envelope_id"]);
      const targets = Object.fromEntries(
        q.targets.map((m) => {
          const s = sanitize(m);
          return [m, { target: text(r[`tgt_${s}`]), actual: text(r[`kpi_${s}`]), vsTargetPct: text(r[`vs_${s}`]) }];
        }),
      );
      return {
        key: grouped ? q.groupBy.map((k) => dims[k] ?? "∅").join("/") : (id as string),
        envelopeId: id,
        ...(grouped ? { nodeEnvelopeId: nodeOf.get(index) ?? null } : { versionId: text(r["head_version_id"]) }),
        path: grouped ? q.groupBy.map((k) => dims[k] ?? "∅") : (paths.get(id as string) ?? [String(r["name"])]),
        dimensions: dims,
        measures: Object.fromEntries(measures.map((m) => [m, measure(m, r[m])])),
        targets,
        status: grouped ? null : text(r["status"]),
        pendingCount: Number(r["pending_count"] ?? 0),
        openAlerts: Number(r["open_alerts"] ?? 0),
        openThreads: Number(r["open_threads"] ?? 0),
      };
    });
    const response: QueryResponse = {
      rows,
      nextCursor: page.nextCursor,
      totals: Object.fromEntries([...measures.map((m) => [m, measure(m, totals?.[m])]), ["leafCount", text(totals?.["leaf_count"])]]),
      dataAsOf: now.toISOString(),
      dataVersion,
      engine: warehouse ? ("warehouse" as const) : ("postgres" as const),
      elapsedMs: Math.round(performance.now() - started),
    };
    if (key && engine.cache) await engine.cache.set(key, JSON.stringify(response), QUERY_CACHE_TTL_SECONDS);
    return response;
  });
}
