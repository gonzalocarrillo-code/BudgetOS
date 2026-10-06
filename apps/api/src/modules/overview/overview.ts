import { DomainError, HEATMAP_SORTS, LIVE_LEAVES, ON_PLAN, PeriodSpec, elapsedFraction, resolvePeriod, todayIso, type FilterGroupT, type OverviewAttentionItem, type OverviewResponse, type Predicate, type QueryResponse, type QueryRow } from "@budget/domain";
import { dataAsOf, fiscalCalendar, projectionFreshness, withTenant } from "@budget/db";
import { elapsedDay } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { headline } from "../../common/headline.js";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { approvalQueue } from "../approvals/queries/desk.js";
import { baselineReport, listBaselines } from "../baselines/queries/baselines.js";
import { alertCounts, openAlerts, type OpenAlert } from "../pacing/queries.js";
import { runQuery } from "../query/queries/run-query.js";

/**
 * GET /workspaces/:ws/overview?period&rows&cols&sort&compareTo (T-033, ADR-029,
 * docs/HOME_OVERVIEW_PLAN.md §3.2): the state of the workspace's money in one round trip, with zero
 * configuration. Every number comes from the planner cut to the caller's read scope, with time gone
 * counted through the day the actuals cover (ADR-062); nothing is summed or ranked in the browser.
 *
 * - The headline reads Budgets' definition of "the budget" (ADR-051); the heatmap sums live leaves.
 * - The heatmap's axes are any two granularities (product feedback 8), with its row and column
 *   totals, each cell's open alerts and budgets waiting, and with `compareTo` the budget then.
 * - "Needs attention" ranks live budgets by money at stake (ADR-064): ahead of plan, behind it, no
 *   spend yet, and CPA over target.
 * - Alerts come by rule, with how many budgets each fires on of how many it covers, and by row value.
 * - The approval queue is the workspace's (the personal list is on Home).
 */
const PRESETS = ["current_month", "current_quarter", "current_year", "last_30_days", "last_90_days", "ytd", "next_90_days"] as const;
/** Budgets that can still need attention: live leaves not ended early (ADR-053). The heatmap keeps ended ones: they spent. */
const LEAVES: Predicate[] = [...LIVE_LEAVES, { field: { kind: "attr", key: "is_ended" }, op: "eq", value: false }];
const HEAT = ["budget", "budget_in_period", "actual", "pace_index", "spend_to_date_pct", "ahead_of_plan_abs"];
const ATTENTION = 10;
/** A rule is worth a hint when it fires on more than half the budgets it covers, and on at least this many. */
const HEALTH_MIN = 10;
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, data: 3 };
const measure = (key: string, op: Predicate["op"], value: number): Predicate => ({ field: { kind: "measure", key: key as "actual" }, op, value });

export interface OverviewParams {
  period?: string | undefined;
  rows?: string | undefined;
  cols?: string | undefined;
  sort?: string | undefined;
  compareTo?: string | undefined;
  /** HF-1: "Show demo data" — overrides T-5's default exclusion for this request only. */
  includeDemo?: boolean | undefined;
}

export async function overview(prisma: PrismaClient, auth: AuthContext, params: OverviewParams = {}, now: Date = new Date()): Promise<OverviewResponse> {
  const started = performance.now();
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const preset = params.period ?? "current_year";
  // A relative preset, or one of the workspace's own periods as `fiscal:<key>` (a quarter as the
  // fiscal calendar defines it, a custom partition), like the Explorer's period picker.
  const fiscal = preset.startsWith("fiscal:") ? preset.slice("fiscal:".length) : null;
  if (fiscal === null && !(PRESETS as readonly string[]).includes(preset)) throw new DomainError("VALIDATION", `period must be one of ${PRESETS.join(", ")} or fiscal:<key>`);
  const period = parseInput(PeriodSpec, fiscal === null ? { kind: "relative", preset } : { kind: "fiscal", key: fiscal });
  const sort = (params.sort ?? "budget") as (typeof HEATMAP_SORTS)[number];
  if (!(HEATMAP_SORTS as readonly string[]).includes(sort)) throw new DomainError("VALIDATION", `sort must be one of ${HEATMAP_SORTS.join(", ")}`);
  if (params.compareTo !== undefined && !/^[0-9a-f-]{36}$/i.test(params.compareTo)) throw new DomainError("VALIDATION", "compareTo must be a snapshot id");
  const today = todayIso(now);

  const setup = await withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true, reportingCurrency: true, fiscalYearStartMonth: true } });
    const dimensions = await tx.dimension.findMany({ where: { orgId: ws.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, label: true } });
    const byKey = new Map(dimensions.map((d) => [d.key, d]));
    const pick = (...keys: string[]) => keys.map((k) => byKey.get(k)).find((d) => d !== undefined) ?? null;
    const chosen = (key: string | undefined) => {
      if (key === undefined || key === "") return undefined;
      const d = byKey.get(key);
      if (!d) throw new DomainError("VALIDATION", `unknown granularity ${key}`, { key });
      return d;
    };
    const rows = chosen(params.rows) ?? pick("country", "market", "region");
    const cols = chosen(params.cols) ?? pick("platform", "channel");
    if (rows && cols && rows.key === cols.key) throw new DomainError("VALIDATION", "rows and cols must be two different granularities");
    const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: [rows?.id, cols?.id].filter((x): x is string => x !== undefined) } }, select: { dimensionId: true, code: true, label: true } });
    const label = (d: typeof rows) => Object.fromEntries(values.filter((v) => v.dimensionId === d?.id).map((v) => [v.code, v.label]));
    const calendar = await fiscalCalendar(tx, workspaceId);
    let range: { start: string; end: string };
    try {
      range = resolvePeriod(period, today, ws.fiscalYearStartMonth, calendar);
    } catch (e) {
      throw new DomainError("VALIDATION", e instanceof Error ? e.message : String(e), { period: preset });
    }
    const metric = await tx.metricDefinition.findFirst({ where: { orgId: ws.orgId, key: "cpa", OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true } });
    // The projection measures are the planner's costly ones; ask for them only when there are projections.
    const [projection] = await tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM projection_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL LIMIT 1`;
    // HO-003 (ADR-062): the last day the actuals cover; time gone (and so pace) is counted through it.
    const asOf = await dataAsOf(tx, workspaceId, today);
    const through = elapsedDay(today, { elapsedThrough: asOf.through ?? undefined });
    const shareGone = (day: string) => elapsedFraction(range, day).toDecimalPlaces(4).toString();
    const rules = await tx.pacingRule.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, name: true, metric: true, severity: true, scope: true } });
    const projections = projection !== undefined ? await projectionFreshness(tx, workspaceId) : null;
    return {
      dims: { rows, cols },
      labels: { rows: label(rows), cols: label(cols) },
      currency: ws.reportingCurrency,
      cpa: metric !== null,
      hasProjections: projection !== undefined,
      range: { ...range, elapsed: shareGone(through), elapsedToday: shareGone(today), daysLeft: Math.max(0, dayNo(range.end) - dayNo(today)) },
      asOf,
      rules,
      projections,
      dimensions: dimensions.map((d) => ({ key: d.key, label: d.label })).sort((a, b) => a.label.localeCompare(b.label)),
    };
  });
  const { dims, labels, currency, cpa, hasProjections, range, asOf, rules } = setup;
  const elapsedThrough = asOf.through ?? undefined;
  // Live leaves (ADR-016): the heatmap, its margins and totals add up to Budgets' leaf totals.
  // HF-1: "Show demo data" (T-5's default exclusion lifted for one request) carries through every
  // query this endpoint runs, the same as Budgets.
  const q = (body: Record<string, unknown>) => runQuery(prisma, auth, { workspaceId, period, filter: { logic: "and", children: LIVE_LEAVES }, includeDemo: params.includeDemo === true, ...body }, now, undefined, { elapsedThrough });
  const rowKey = dims.rows?.key ?? "";
  const colKey = dims.cols?.key ?? "";
  const leavesAnd = (...more: Predicate[]): FilterGroupT => ({ logic: "and", children: [...LEAVES, ...more] });
  const ATT = ["budget", "budget_in_period", "actual", "pace_index", "spend_to_date_pct", "ahead_of_plan_abs"];
  // KPI targets sit on the market-level budgets (a market set, no platform): read them there.
  const marketLevel: FilterGroupT = { logic: "and", children: [{ field: { kind: "dimension", key: rowKey }, op: "not_empty" }, { field: { kind: "dimension", key: colKey }, op: "is_empty" }, { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] };
  // The headline (UX-008, ADR-051): the same "budget" as Budgets and Home.
  const head = headline(auth);
  const sortKey = sort === "pace" ? "pace_index" : sort === "ahead" ? "ahead_of_plan_abs" : "budget";

  // The snapshot to compare with: the one asked for, else the latest plan snapshot (Phase E, H-007).
  const snapshots = (await listBaselines(prisma, auth, {})).baselines;
  const snapshot = params.compareTo !== undefined ? (snapshots.find((b) => b.id === params.compareTo) ?? null) : ([...snapshots].filter((b) => b.kind === "plan" && b.archivedAt === null).sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null);
  if (params.compareTo !== undefined && snapshot === null) throw new DomainError("NOT_FOUND", "Snapshot not found", { compareTo: params.compareTo });
  const compareCells = params.compareTo !== undefined ? { compareTo: { baselineId: params.compareTo } } : {};

  const [heat, rowTotals, colTotals, liveTotals, over, under, noSpend, kpiOff, kpi, kpiTargets, headTotals, alerts, queue, sources, report] = await Promise.all([
    dims.rows && dims.cols ? q({ groupBy: [rowKey, colKey], measures: [...HEAT, ...(params.compareTo ? ["budget_baseline", "budget_change_abs"] : [])], ...compareCells, sort: [{ key: "budget", dir: "desc" }], limit: 1000 }) : null,
    // T-7: fetched well past the 50 actually shown (HEATMAP_TOP below), so a row/col beyond the cut
    // — including the ∅ bucket, grouped under a null code like any other value — is still counted
    // into `gap` instead of silently vanishing from `totals`.
    dims.rows && dims.cols ? q({ groupBy: [rowKey], measures: HEAT, sort: [{ key: sortKey, dir: "desc" }], limit: 1000 }) : null,
    dims.rows && dims.cols ? q({ groupBy: [colKey], measures: HEAT, sort: [{ key: "budget", dir: "desc" }], limit: 1000 }) : null,
    // No row/col axes, so no heatmap (T-3): the same live-leaf totals it would have had, ungrouped.
    !(dims.rows && dims.cols) ? q({ measures: HEAT, limit: 1 }) : null,
    // Needs attention (ADR-064): ahead of plan and past the on-plan band, largest first …
    q({ filter: leavesAnd(measure("pace_index", "gte", ON_PLAN.to), measure("ahead_of_plan_abs", "gt", 0)), measures: ATT, sort: [{ key: "ahead_of_plan_abs", dir: "desc" }], limit: ATTENTION }),
    // … behind it with some spend …
    q({ filter: leavesAnd(measure("actual", "gt", 0), measure("pace_index", "lt", ON_PLAN.from), measure("ahead_of_plan_abs", "lt", 0)), measures: ATT, sort: [{ key: "ahead_of_plan_abs", dir: "asc" }], limit: ATTENTION }),
    // … nothing spent although time has gone …
    q({ filter: leavesAnd(measure("actual", "lte", 0), measure("ahead_of_plan_abs", "lt", 0)), measures: ATT, sort: [{ key: "ahead_of_plan_abs", dir: "asc" }], limit: ATTENTION }),
    // … and CPA more than 10% over target (the default rule's threshold).
    cpa ? q({ filter: leavesAnd({ field: { kind: "target", metric: "cpa", field: "vs_target_pct" }, op: "gt", value: 1.1 }), measures: ATT, targets: ["cpa"], sort: [{ key: "vs_cpa", dir: "desc" }], limit: ATTENTION }) : null,
    dims.rows && cpa ? q({ groupBy: [rowKey], measures: ["budget", "actual"], targets: ["cpa"], sort: [{ key: "budget", dir: "desc" }], limit: 12 }) : null,
    dims.rows && dims.cols && cpa ? q({ filter: marketLevel, measures: ["budget"], targets: ["cpa"], limit: 200 }) : null,
    head ? q({ filter: head.filter, subtree: head.subtree, measures: ["budget", "actual", "remaining", "pace_index", "spend_to_date_pct", ...(hasProjections ? ["projected", "projected_close_pct"] : [])], limit: 1 }) : null,
    openAlerts(prisma, auth),
    approvalQueue(prisma, auth, now),
    freshness(prisma, auth, workspaceId, asOf.lastFactDate),
    snapshot ? baselineReport(prisma, auth, snapshot.id, {}).catch(() => null) : null,
  ]);

  // Where each open alert sits on the heatmap's axes.
  const place = await alertPlaces(prisma, auth, alerts, [dims.rows, dims.cols].filter((d): d is NonNullable<typeof d> => d !== null && d !== undefined).map((d) => ({ key: d.key, id: d.id })));
  const alertsAt = (row: string | null, col: string | null) => alerts.filter((a) => (row === null || place.get(a.envelopeId)?.[rowKey] === row) && (col === null || place.get(a.envelopeId)?.[colKey] === col)).length;

  // T-7: a leaf with no value for the row/col dimension still carries its money, under this code
  // (never dropped as a bare null would be), so the ∅ row/column can show it.
  const NO_DIMENSION_VALUE = "__none__";
  const HEATMAP_TOP = 50;
  const measuresOf = (r: QueryRow) => Object.fromEntries(HEAT.map((m) => [m, r.measures[m] ?? null])) as Record<string, string | null>;
  const cells = (heat?.rows ?? []).map((r) => {
    const row = r.dimensions[rowKey] ?? NO_DIMENSION_VALUE;
    const col = r.dimensions[colKey] ?? NO_DIMENSION_VALUE;
    return { row, col, ...r.measures, alerts: alertsAt(row, col), pending: r.pendingCount };
  });
  const margins = (res: QueryResponse | null, key: string, axis: "row" | "col") =>
    (res?.rows ?? []).map((r) => {
      const code = r.dimensions[key] ?? NO_DIMENSION_VALUE;
      return { code, ...measuresOf(r), alerts: axis === "row" ? alertsAt(code, null) : alertsAt(null, code) };
    });
  // Every row/col code with a margin (fetched well past what's shown, see above), already ranked by
  // the query's own sort.
  const rowMarginsAll = margins(rowTotals, rowKey, "row");
  const colMarginsAll = margins(colTotals, colKey, "col");
  const withCells = new Set(cells.flatMap((c) => [c.row, c.col]));
  // The top 50 shown, keeping the ∅ bucket even past that cut so its money is never silently hidden.
  const shownOrder = (all: Array<{ code: string }>) => {
    const top = all.slice(0, HEATMAP_TOP).map((m) => m.code);
    const withNone = all.some((m) => m.code === NO_DIMENSION_VALUE) && !top.includes(NO_DIMENSION_VALUE) ? [...top, NO_DIMENSION_VALUE] : top;
    return withNone.filter((c) => withCells.has(c));
  };
  const rowOrder = shownOrder(rowMarginsAll);
  const colOrder = shownOrder(colMarginsAll);
  // Only the shown margins go to the client (the same bound as before); the money beyond them is `gap`.
  const rowMargins = rowMarginsAll.filter((m) => rowOrder.includes(m.code));
  const colMargins = colMarginsAll.filter((m) => colOrder.includes(m.code));
  // T-7: cells + margins + gap == totals exactly. `margins` is what's shown in one axis only (a
  // shown row's money in a hidden column, or vice versa); `gap` is neither axis shown — the money
  // that was simply never sent, the top-50 cut used to drop silently. Reads straight off `heat.rows`
  // (not the already-spread `cells`) so the dynamic "budget" | "actual" index keeps its type.
  const heatmapGapSum = (key: "budget" | "actual") =>
    (heat?.rows ?? [])
      .filter((r) => !rowOrder.includes(r.dimensions[rowKey] ?? NO_DIMENSION_VALUE) && !colOrder.includes(r.dimensions[colKey] ?? NO_DIMENSION_VALUE))
      .reduce((s, r) => s.plus(new Decimal(r.measures[key] ?? 0)), new Decimal(0));
  const rowCodeCount = new Set(cells.map((c) => c.row)).size;
  const colCodeCount = new Set(cells.map((c) => c.col)).size;
  const heatmapGap = { budget: heatmapGapSum("budget").toFixed(2), actual: heatmapGapSum("actual").toFixed(2), rows: Math.max(0, rowCodeCount - rowOrder.length), cols: Math.max(0, colCodeCount - colOrder.length) };

  const targetOf = new Map((kpiTargets?.rows ?? []).map((r) => [r.dimensions[rowKey] ?? "", r.targets["cpa"]?.target ?? null]));
  // CPA: lower is better, so a positive gap is worse than target.
  const gap = (actual: string | null, target: string | null) => (actual === null || target === null || new Decimal(target).isZero() ? null : new Decimal(actual).div(target).minus(1).toDecimalPlaces(4).toString());
  const kpiRows = (kpi?.rows ?? []).map((r) => {
    const code = r.dimensions[rowKey] ?? null;
    const actual = r.targets["cpa"]?.actual ?? null;
    const target = targetOf.get(code ?? "") ?? null;
    return { code, label: labels.rows[code ?? ""] ?? null, budget: r.measures["budget"] ?? null, actual: actual === null ? null : new Decimal(actual).toDecimalPlaces(2).toFixed(2), target, vsTargetPct: gap(actual, target) };
  });
  // Worst first: the largest gap over target leads (a gap-less row goes last).
  kpiRows.sort((a, b) => (b.vsTargetPct === null ? -Infinity : Number(b.vsTargetPct)) - (a.vsTargetPct === null ? -Infinity : Number(a.vsTargetPct)));

  // Each budget's open alerts, for the bell's hover card (worst first).
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));
  const alertsByBudget = new Map<string, OpenAlert[]>();
  for (const a of alerts) alertsByBudget.set(a.envelopeId, [...(alertsByBudget.get(a.envelopeId) ?? []), a]);
  const alertListOf = (envelopeId: string) =>
    (alertsByBudget.get(envelopeId) ?? [])
      .slice()
      .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9) || y.openedAt.getTime() - x.openedAt.getTime())
      .map((x) => ({ id: x.id, rule: ruleName.get(x.ruleId) ?? null, severity: x.severity, openedAt: x.openedAt.toISOString() }));
  const attention = attentionOf({ over, under, noSpend, kpiOff }, alertListOf);
  const byRule = await rulesOf(alerts, rules, place, rowKey, labels.rows, (scope) => q({ filter: scope, measures: ["budget"], limit: 1 }));
  const headRow = headTotals?.totals ?? null;
  const liveTotalsOf = heat ?? liveTotals;
  const assigned = liveTotalsOf?.totals["budget"] ?? null;
  const remaining = headRow?.["remaining"] ?? null;
  const daysLeft = range.daysLeft;
  return {
    period: { preset, ...range },
    asOf,
    currency,
    dataAsOf: (heat ?? over).dataAsOf,
    headline:
      headRow && head
        ? {
            basis: head.basis,
            budget: headRow["budget"] ?? null,
            actual: headRow["actual"] ?? null,
            spentPct: headRow["spend_to_date_pct"] ?? null,
            paceIndex: headRow["pace_index"] ?? null,
            assigned,
            // ADR-051: what is approved at the top but not split into leaves yet, and the share that is.
            unassigned: assigned !== null && headRow["budget"] ? new Decimal(headRow["budget"]).minus(assigned).toFixed(2) : null,
            assignedPct: assigned !== null && headRow["budget"] && new Decimal(headRow["budget"]).gt(0) ? new Decimal(assigned).div(headRow["budget"]).toDecimalPlaces(4).toString() : null,
            remaining,
            // What is left over the calendar days left: a division, not a forecast.
            runRateNeeded: remaining !== null && daysLeft > 0 && new Decimal(remaining).gt(0) ? new Decimal(remaining).div(daysLeft).toDecimalPlaces(2).toFixed(2) : null,
            projected: hasProjections ? (headRow["projected"] ?? null) : null,
            projectedClosePct: hasProjections ? (headRow["projected_close_pct"] ?? null) : null,
          }
        : null,
    compare:
      snapshot && report
        ? { id: snapshot.id, name: snapshot.name, kind: snapshot.kind, asOf: snapshot.asOf, explicit: params.compareTo !== undefined, changeAbs: report.change.abs, changePct: report.change.pct, counts: { increased: report.counts.increased, decreased: report.counts.decreased, new: report.counts.new, ended: report.counts.ended } }
        : null,
    totals: { ...(liveTotalsOf?.totals ?? over.totals) },
    heatmap:
      dims.rows && dims.cols
        ? {
            rowDimension: { key: dims.rows.key, label: dims.rows.label },
            colDimension: { key: dims.cols.key, label: dims.cols.label },
            rows: rowOrder,
            cols: colOrder,
            labels,
            cells,
            dimensions: setup.dimensions,
            rowTotals: rowMargins,
            colTotals: colMargins,
            total: heat ? (Object.fromEntries(HEAT.map((m) => [m, heat.totals[m] ?? null])) as Record<string, string | null>) : null,
            gap: heatmapGap,
            sort,
          }
        : null,
    attention,
    kpi: kpi && dims.rows ? { metric: "cpa", direction: "lower_is_better", dimension: { key: dims.rows.key, label: dims.rows.label }, rows: kpiRows } : null,
    alerts: { ...alertCounts(alerts), byRule, byRow: countBy(alerts.map((a) => place.get(a.envelopeId)?.[rowKey] ?? null), labels.rows) },
    queue,
    freshness: { ...sources, projections: setup.projections },
    elapsedMs: Math.round(performance.now() - started),
  };
}

const DAY = 86_400_000;
const dayNo = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);

/** Each open alert's budget's code on the given granularities (two reads for all of them). */
async function alertPlaces(prisma: PrismaClient, auth: AuthContext, alerts: readonly OpenAlert[], dims: Array<{ key: string; id: string }>): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const ids = [...new Set(alerts.map((a) => a.envelopeId))];
  if (ids.length === 0 || dims.length === 0) return out;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const keyOf = new Map(dims.map((d) => [d.id, d.key]));
    const rows = await tx.envelopeDimension.findMany({ where: { envelopeId: { in: ids }, dimensionId: { in: dims.map((d) => d.id) } }, select: { envelopeId: true, dimensionId: true, valueId: true } });
    const codes = new Map((await tx.dimensionValue.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.valueId))] } }, select: { id: true, code: true } })).map((v) => [v.id, v.code]));
    for (const r of rows) {
      const key = keyOf.get(r.dimensionId);
      const code = codes.get(r.valueId);
      if (key !== undefined && code !== undefined) out.set(r.envelopeId, { ...(out.get(r.envelopeId) ?? {}), [key]: code });
    }
    return out;
  });
}

/** Counts per value, largest first, with the value's label. */
function countBy(codes: Array<string | null>, labels: Record<string, string>): Array<{ code: string | null; label: string | null; count: number }> {
  const m = new Map<string | null, number>();
  for (const c of codes) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m].map(([code, count]) => ({ code, label: code === null ? null : (labels[code] ?? code), count })).sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
}

/**
 * Open alerts by rule (HO-010): count, the budgets it fires on, the budgets it covers (for a rule
 * firing on many, so the page can say "one rule fires on half the workspace"), and the rows it hits.
 */
async function rulesOf(
  alerts: readonly OpenAlert[],
  rules: Array<{ id: string; name: string; metric: string; severity: string; scope: unknown }>,
  place: Map<string, Record<string, string>>,
  rowKey: string,
  rowLabels: Record<string, string>,
  count: (scope: FilterGroupT) => Promise<QueryResponse>,
): Promise<OverviewResponse["alerts"]["byRule"]> {
  const byRule = new Map<string, OpenAlert[]>();
  for (const a of alerts) byRule.set(a.ruleId, [...(byRule.get(a.ruleId) ?? []), a]);
  const out = await Promise.all(
    [...byRule].map(async ([ruleId, list]) => {
      const rule = rules.find((r) => r.id === ruleId);
      const budgets = new Set(list.map((a) => a.envelopeId)).size;
      let covered: number | null = null;
      if (budgets >= HEALTH_MIN) {
        const scope = rule?.scope as FilterGroupT | null | undefined;
        const res = await count({ logic: "and", children: [...LEAVES, ...(scope && Array.isArray(scope.children) && scope.children.length > 0 ? [scope] : [])] });
        covered = Number(res.totals["leafCount"] ?? 0);
      }
      const severity = list.reduce((s, a) => ((SEVERITY_RANK[a.severity] ?? 9) < (SEVERITY_RANK[s] ?? 9) ? a.severity : s), list[0]?.severity ?? "info");
      return { ruleId, ruleName: rule?.name ?? null, severity, metric: rule?.metric ?? null, count: list.length, budgets, covered, byRow: countBy(list.map((a) => place.get(a.envelopeId)?.[rowKey] ?? null), rowLabels).slice(0, 5) };
    }),
  );
  return out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.count - a.count);
}

/** The four lists of budgets that need attention, and all of them together by money at stake (ADR-064). */
function attentionOf(res: { over: QueryResponse; under: QueryResponse; noSpend: QueryResponse; kpiOff: QueryResponse | null }, alertListOf: (envelopeId: string) => OverviewAttentionItem["alertList"]): NonNullable<OverviewResponse["attention"]> {
  const item = (category: OverviewAttentionItem["category"], r: QueryRow): OverviewAttentionItem | null => {
    if (r.envelopeId === null) return null;
    const ahead = r.measures["ahead_of_plan_abs"] ?? "0";
    const t = r.targets["cpa"];
    // CPA over target: what the spend costs above the target, spend × (1 − 1 ÷ (actual ÷ target)).
    const vs = t?.vsTargetPct ? new Decimal(t.vsTargetPct) : null;
    const money = category === "kpi" ? (vs !== null && vs.gt(0) ? new Decimal(r.measures["actual"] ?? 0).mul(new Decimal(1).minus(new Decimal(1).div(vs))).toFixed(2) : "0.00") : new Decimal(ahead).toFixed(2);
    return {
      category,
      envelopeId: r.envelopeId,
      name: r.path.at(-1) ?? "",
      path: r.path,
      budget: r.measures["budget"] ?? null,
      budget_in_period: r.measures["budget_in_period"] ?? null,
      actual: r.measures["actual"] ?? null,
      pace_index: r.measures["pace_index"] ?? null,
      spend_to_date_pct: r.measures["spend_to_date_pct"] ?? null,
      ahead_of_plan_abs: r.measures["ahead_of_plan_abs"] ?? null,
      money,
      alerts: r.openAlerts,
      alertList: alertListOf(r.envelopeId),
      pending: r.status === "PENDING",
      endDate: r.endDate ?? null,
      kpi: category === "kpi" && t ? { metric: "cpa", actual: t.actual, target: t.target, vsTargetPct: t.vsTargetPct } : null,
    };
  };
  const list = (category: OverviewAttentionItem["category"], q: QueryResponse | null) => (q?.rows ?? []).map((r) => item(category, r)).filter((x): x is OverviewAttentionItem => x !== null);
  const over = list("over", res.over);
  const under = list("under", res.under);
  const noSpend = list("no_spend", res.noSpend);
  const kpi = list("kpi", res.kpiOff);
  // One row per budget in "All": the category with the most money at stake wins.
  const best = new Map<string, OverviewAttentionItem>();
  for (const i of [...over, ...under, ...noSpend, ...kpi]) {
    const prev = best.get(i.envelopeId);
    if (!prev || new Decimal(i.money).abs().gt(new Decimal(prev.money).abs())) best.set(i.envelopeId, i);
  }
  const all = [...best.values()].sort((a, b) => new Decimal(b.money).abs().comparedTo(new Decimal(a.money).abs()) || a.name.localeCompare(b.name)).slice(0, ATTENTION);
  const n = (q: QueryResponse | null) => Number(q?.totals["leafCount"] ?? 0);
  return { all, over, under, noSpend, kpi, counts: { over: n(res.over), under: n(res.under), noSpend: n(res.noSpend), kpi: n(res.kpiOff) } };
}

/** Each source's last run: how fresh the actuals are (plan §11.1). */
async function freshness(prisma: PrismaClient, auth: AuthContext, workspaceId: string, lastFactDate: string | null) {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const sources = await tx.dataSource.findMany({ where: { workspaceId }, select: { id: true, name: true, kind: true, isActive: true }, orderBy: { name: "asc" } });
    const runs = await Promise.all(sources.map((s) => tx.ingestRun.findFirst({ where: { sourceId: s.id }, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true, rowsRejected: true, summary: true } })));
    return {
      lastFactDate,
      sources: sources.map((s, i) => {
        const r = runs[i];
        const coverage = (r?.summary as { matchCoverage?: string } | null)?.matchCoverage ?? null;
        return { ...s, lastRun: r ? { status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, rowsRejected: r.rowsRejected, matchCoverage: coverage } : null };
      }),
    };
  });
}
