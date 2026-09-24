import { ScopeFilter, type ScopeFilter as ScopeFilterT } from "@budget/domain";
import type { Tx } from "@budget/db";
import type { CompileOptions, FilterTarget, MetricDef } from "@budget/query-planner";

/** Number of dimension predicates in a scope; more predicates = more specific. */
function specificity(scope: ScopeFilterT): number {
  if (!("children" in scope)) return 0;
  return scope.children.reduce((n, c) => n + ("children" in c ? specificity(c) : 1), 0);
}

export interface CurrentFilterTarget extends FilterTarget {
  targetId: string;
  comparator: string;
}

/**
 * Current filter-scoped targets for some metrics whose dates overlap the period, most specific
 * first (then newest), which is the order the planner and the envelope drawer both apply.
 */
export async function currentFilterTargets(tx: Tx, workspaceId: string, metricKeys: string[], period: { start: string; end: string }): Promise<CurrentFilterTarget[]> {
  if (metricKeys.length === 0) return [];
  const rows = await tx.target.findMany({
    where: {
      workspaceId,
      scopeType: "filter",
      status: "active",
      metricKey: { in: metricKeys },
      currentVersionId: { not: null },
      startDate: { lte: new Date(`${period.end}T00:00:00Z`) },
      endDate: { gte: new Date(`${period.start}T00:00:00Z`) },
    },
    orderBy: { id: "desc" },
  });
  const versions = new Map(
    (await tx.targetVersion.findMany({ where: { id: { in: rows.map((r) => r.currentVersionId as string) } }, select: { id: true, value: true, comparator: true } })).map((v) => [v.id, v]),
  );
  const out: CurrentFilterTarget[] = [];
  for (const r of rows) {
    const scope = ScopeFilter.safeParse(r.scopeFilter);
    const v = versions.get(r.currentVersionId as string);
    if (!scope.success || v === undefined) continue; // unreadable scope: never applied
    out.push({ targetId: r.id, metricKey: r.metricKey, value: v.value.toString(), comparator: v.comparator, scope: scope.data });
  }
  // Stable sort keeps newest-first within equal specificity.
  return out.sort((a, b) => specificity(b.scope) - specificity(a.scope));
}

/** The org's metric library as the planner reads it. */
export async function metricLibrary(tx: Tx, orgId: string): Promise<Map<string, MetricDef>> {
  const rows = await tx.metricDefinition.findMany({ where: { orgId, isActive: true } });
  return new Map(rows.map((m) => [m.key, { numerator: m.numerator, denominator: m.denominator, multiplier: m.multiplier.toString() }]));
}

/** CompileOptions for a query: metric library plus the filter-scoped targets of the requested metrics. */
export async function plannerOptions(tx: Tx, ctx: { orgId: string; workspaceId: string }, metricKeys: string[], period: { start: string; end: string }): Promise<CompileOptions> {
  return { metrics: await metricLibrary(tx, ctx.orgId), filterTargets: await currentFilterTargets(tx, ctx.workspaceId, metricKeys, period) };
}
