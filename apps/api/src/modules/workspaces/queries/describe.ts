import { LIVE_LEAVES, MeasureKey, normTerm, resolvePeriod, type FilterGroupT } from "@budget/domain";
import { fiscalCalendar, lastFactDate, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { headline } from "../../../common/headline.js";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { listBaselines } from "../../baselines/queries/baselines.js";
import { listClosures } from "../../closures/queries/closures.js";
import { runQuery } from "../../query/queries/run-query.js";
import { describeRegistry } from "../../registry/queries/list-registry.js";
import { listMappingSynonyms } from "../../sources/queries/mapping.js";

/**
 * What an AI needs to know about a workspace before it asks anything (docs/DATA_PLAN.md §7, D-010
 * and D-011), in one read, as the caller may see it (their scope, RLS): the calendar, every
 * granularity with how much budget each value holds, the hierarchies, the metric library with its
 * formulas and the words people use for them (tCPA is CPA), the headline for the fiscal year (the
 * same numbers Overview shows), counts, snapshots and closes, and how fresh the actuals are.
 * Everything here exists behind other tools; this is the orientation, sized for a prompt.
 */

const TOP_DIMENSIONS = 10;
const TOP_VALUES = 8;

const num = (v: string | null | undefined) => (v === undefined ? null : v);

export async function describeWorkspace(prisma: PrismaClient, auth: AuthContext, now: Date = new Date()) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const today = now.toISOString().slice(0, 10);
  const base = await withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, reportingCurrency: true, fiscalYearStartMonth: true } });
    const calendar = await fiscalCalendar(tx, workspaceId);
    // Which granularities the live budgets use, and how many distinct values of each.
    const usage = await tx.envelopeDimension.groupBy({ by: ["dimensionId"], where: { envelope: { workspaceId, status: { not: "ARCHIVED" } } }, _count: { _all: true } });
    const distinct = await tx.envelopeDimension.groupBy({ by: ["dimensionId", "valueId"], where: { envelope: { workspaceId, status: { not: "ARCHIVED" } } } });
    const metrics = await tx.metricDefinition.findMany({ where: { orgId: auth.user.orgId, OR: [{ workspaceId: null }, { workspaceId }] }, orderBy: { key: "asc" }, select: { key: true, label: true, numerator: true, denominator: true, multiplier: true, direction: true, format: true } });
    const counts = {
      budgets: await tx.envelope.count({ where: { workspaceId, status: { not: "ARCHIVED" } } }),
      topLevelBudgets: await tx.envelope.count({ where: { workspaceId, status: { not: "ARCHIVED" }, parentId: null } }),
      leafBudgets: await tx.envelope.count({ where: { workspaceId, status: { not: "ARCHIVED" }, children: { none: { status: { not: "ARCHIVED" } } } } }),
      endedBudgets: await tx.envelope.count({ where: { workspaceId, endedAt: { not: null } } }),
      waitingForApproval: await tx.approvalRequest.count({ where: { workspaceId, status: { in: ["PENDING", "ESCALATED"] } } }),
      openAlerts: await tx.alert.count({ where: { workspaceId, status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      dataSources: await tx.dataSource.count({ where: { workspaceId, isActive: true } }),
    };
    return { ws, calendar, usage, distinct, metrics, counts, lastFact: await lastFactDate(tx, workspaceId) };
  });
  const registry = await describeRegistry(prisma, auth);
  const idToKey = new Map(registry.dimensions.map((d) => [d.id, d.key]));
  const used = new Map(base.usage.map((u) => [idToKey.get(u.dimensionId), u._count._all]));
  const valuesInUse = new Map<string, number>();
  for (const d of base.distinct) {
    const k = idToKey.get(d.dimensionId);
    if (k) valuesInUse.set(k, (valuesInUse.get(k) ?? 0) + 1);
  }
  const fy = resolvePeriod({ kind: "relative", preset: "current_year" }, today, base.ws.fiscalYearStartMonth, base.calendar);
  const quarter = resolvePeriod({ kind: "relative", preset: "current_quarter" }, today, base.ws.fiscalYearStartMonth, base.calendar);
  const period = { kind: "relative", preset: "current_year" } as const;

  // How the fiscal year's budget splits over each granularity in use (the biggest values first).
  const inUse = registry.dimensions.filter((d) => d.isActive && used.has(d.key)).sort((a, b) => (used.get(b.key) ?? 0) - (used.get(a.key) ?? 0)).slice(0, TOP_DIMENSIONS);
  const leaves: FilterGroupT = { logic: "and", children: LIVE_LEAVES };
  const tops = await Promise.all(
    inUse.map(async (d) => {
      const r = await runQuery(prisma, auth, { workspaceId, filter: leaves, groupBy: [d.key], measures: ["budget", "actual", "pace_index"], period, sort: [{ key: "budget", dir: "desc" }], limit: TOP_VALUES }, now);
      const label = new Map(d.values.map((v) => [v.code, v.label]));
      return r.rows.map((row) => {
        const code = row.dimensions[d.key] ?? null;
        return { code, label: code ? (label.get(code) ?? code) : `No ${d.label}`, budget: num(row.measures["budget"]), actual: num(row.measures["actual"]), paceIndex: num(row.measures["pace_index"]) };
      });
    }),
  );
  const head = headline(auth);
  const headlineTotals = head ? (await runQuery(prisma, auth, { workspaceId, filter: head.filter, measures: ["budget", "actual", "projected", "pace_index", "spend_to_date_pct"], period, ...(head.subtree ? { subtree: true } : {}), limit: 1 }, now)).totals : null;

  const synonyms = await listMappingSynonyms(prisma, auth);
  const wordsFor = (metric: string) => synonyms.metrics.filter((s) => s.isActive && (s.target as { metric?: string }).metric === metric).map((s) => s.term);
  const snapshots = (await listBaselines(prisma, auth, {})).baselines.slice(0, 10).map((b) => ({ id: b.id, name: b.name, kind: b.kind, periodKey: b.periodKey, asOf: b.asOf, total: b.total }));
  const closures = ((await listClosures(prisma, auth)) as Array<{ period: { key: string }; status: string; closedAt: string }>).slice(0, 5).map((c) => ({ periodKey: c.period.key, status: c.status, closedAt: c.closedAt }));

  return {
    workspace: { id: workspaceId, name: base.ws.name, reportingCurrency: base.ws.reportingCurrency, fiscalYearStartMonth: base.ws.fiscalYearStartMonth, today, fiscalYear: fy, currentQuarter: quarter },
    headline: headlineTotals && head
      ? { basis: head.basis, period: "current_year", budget: num(headlineTotals["budget"]), actual: num(headlineTotals["actual"]), projected: num(headlineTotals["projected"]), paceIndex: num(headlineTotals["pace_index"]), spentPct: num(headlineTotals["spend_to_date_pct"]) }
      : null,
    counts: { ...base.counts, ...Object.fromEntries(inUse.map((d) => [`${d.key}Values`, valuesInUse.get(d.key) ?? 0])) },
    dimensions: registry.dimensions
      .filter((d) => d.isActive)
      .map((d) => ({
        key: d.key,
        label: d.label,
        values: d.values.filter((v) => v.isActive).length,
        inUse: { budgets: used.get(d.key) ?? 0, values: valuesInUse.get(d.key) ?? 0 },
        // The fiscal year's budget by value, biggest first (only for the granularities budgets use).
        top: tops[inUse.findIndex((x) => x.key === d.key)] ?? null,
        words: synonyms.columns.filter((s) => s.isActive && (s.target as { dimension?: string }).dimension === d.key).map((s) => s.term),
      })),
    hierarchies: registry.hierarchyTemplates.map((t) => ({ name: t.name, path: t.path, isDefault: t.isDefault })),
    metrics: base.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      formula: m.denominator ? `${m.numerator} / ${m.denominator}${m.multiplier.equals(1) ? "" : ` × ${m.multiplier.toString()}`}` : m.numerator,
      isRatio: m.denominator !== null,
      direction: m.direction,
      format: m.format,
      words: wordsFor(m.key),
    })),
    snapshots,
    closures,
    freshness: { lastFactDate: base.lastFact },
    queryHints: {
      dimensionKeys: registry.dimensions.filter((d) => d.isActive).map((d) => d.key),
      measures: MeasureKey.options,
      metricKeysForTargets: base.metrics.map((m) => m.key),
      periodPresets: ["current_month", "current_quarter", "current_year", "ytd", "last_30_days", "last_90_days", "next_90_days"],
      notes: [
        "Filters are the FilterGroup AST: { logic: 'and', children: [{ field: { kind: 'dimension', key }, op: 'eq' | 'in' | …, value }] } with codes from `dimensions`.",
        "Leaf budgets: add { field: { kind: 'attr', key: 'is_leaf' }, op: 'eq', value: true } so parents and children are not counted twice.",
        "The workspace's budget is its top-level budgets with their subtree's spend (`headline`): parent_id is_empty and subtree: true.",
        "Ratios (CPA, ROAS, CTR…) are computed from counts at every level: ask for them as targets: [metricKey] in query_budgets, never sum them.",
        "Compare with a snapshot: compareTo: { baselineId } adds budget_baseline, budget_change_abs and budget_change_pct.",
      ],
    },
  };
}

/**
 * The workspace's words (D-011): what each granularity, metric, status and concept is called here,
 * with the synonyms the mapping wizard learned. Fed by the same list, so a word learned from a
 * client's file is a word an AI knows.
 */
export async function workspaceGlossary(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const registry = await describeRegistry(prisma, auth);
  const synonyms = await listMappingSynonyms(prisma, auth);
  const metrics = await withTenant(prisma, auth.ctx, (tx) => tx.metricDefinition.findMany({ where: { orgId: auth.user.orgId, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, label: true, numerator: true, denominator: true } }));
  return {
    dimensions: registry.dimensions.filter((d) => d.isActive).map((d) => ({ key: d.key, label: d.label, words: [normTerm(d.label), ...synonyms.columns.filter((s) => s.isActive && (s.target as { dimension?: string }).dimension === d.key).map((s) => s.term)] })),
    metrics: metrics.map((m) => ({ key: m.key, label: m.label, isRatio: m.denominator !== null, words: synonyms.metrics.filter((s) => s.isActive && (s.target as { metric?: string }).metric === m.key).map((s) => s.term) })),
    ratioWords: synonyms.ratioWords,
    statuses: {
      DRAFT: "Not approved yet; counts as no budget.",
      PENDING: "A change is waiting for approval; the approved amount still applies.",
      APPROVED: "The approved amount is live.",
      LOCKED: "Its period is closed.",
      ARCHIVED: "Removed from the tree and totals; kept for history.",
      ENDED: "Stopped on its end date with a final amount; read-only; may be continued by a successor.",
    },
    concepts: {
      budget: "An envelope: an amount for a combination of granularities over dates. Parents are caps over their children.",
      headline: "The workspace's budget: its top-level budgets, each with everything spent under it.",
      pace_index: "Spend so far over the budget's share of the period so far; 1.00 is on plan.",
      projected_close: "Projected spend at the end of the period over the budget.",
      snapshot: "A copy of the approved amounts and the tree, saved by hand (a plan, a close, or any moment).",
      close: "A closed period: its budgets locked and its budget-vs-actual frozen.",
      successor: "A budget that continues an ended one (lineage `continues`).",
    },
  };
}
