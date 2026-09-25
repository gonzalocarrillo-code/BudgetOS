import { DomainError, QueryRequest, readScopeFilter, resolvePeriod, type FilterGroupT, type QueryResponse } from "@budget/domain";
import { envelopePaths, plannerOptions, withTenant } from "@budget/db";
import { compileQuery, compileTotals, pageOf, sanitize } from "@budget/query-planner";
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

export async function runQuery(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()): Promise<QueryResponse> {
  const started = performance.now();
  const q = scopedQuery(auth, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: q.workspaceId }, select: { fiscalYearStartMonth: true, settings: true } });
    const today = now.toISOString().slice(0, 10);
    const period = resolvePeriod(q.period, today, ws.fiscalYearStartMonth);
    const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId: q.workspaceId }, q.targets, period);
    const c = compileQuery(q, period, today, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
    const t = compileTotals(q, period, today, opts);
    const [totals] = await tx.$queryRawUnsafe<Row[]>(t.sql, ...t.values);
    const grouped = q.groupBy.length > 0;
    const paths = grouped ? new Map<string, string[]>() : await envelopePaths(tx, page.rows.map((r) => String(r["envelope_id"])));
    const measures = [...new Set(q.measures)];
    const rows = page.rows.map((r) => {
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
        ...(grouped ? {} : { versionId: text(r["head_version_id"]) }),
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
    return {
      rows,
      nextCursor: page.nextCursor,
      totals: Object.fromEntries([...measures.map((m) => [m, measure(m, totals?.[m])]), ["leafCount", text(totals?.["leaf_count"])]]),
      dataAsOf: now.toISOString(),
      dataVersion: Number((ws.settings as { dataVersion?: number } | null)?.dataVersion ?? 0),
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}
