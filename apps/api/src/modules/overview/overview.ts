import { DomainError, LIVE_LEAVES, PeriodSpec, type QueryResponse } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { listApprovals } from "../approvals/queries/approvals.js";
import { listAlerts } from "../pacing/queries.js";
import { runQuery } from "../query/queries/run-query.js";

/**
 * GET /workspaces/:ws/overview?period (T-033, plan §11.1 / Epic 1.11): everything the Overview
 * shows, in one round trip and with zero configuration. Every number comes from the planner cut to
 * the caller's read scope (live leaves, so nothing is counted twice); nothing is summed in the
 * browser. Market × platform are the registry's `country` × `platform`, or the first of
 * region / channel when a workspace has no such granularity.
 */
const PRESETS = ["current_month", "current_quarter", "current_year", "last_30_days", "last_90_days", "ytd", "next_90_days"] as const;
const leaves = { logic: "and" as const, children: LIVE_LEAVES };

export async function overview(prisma: PrismaClient, auth: AuthContext, rawPeriod: string | undefined) {
  const started = performance.now();
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const preset = rawPeriod ?? "current_year";
  if (!(PRESETS as readonly string[]).includes(preset)) throw new DomainError("VALIDATION", `period must be one of ${PRESETS.join(", ")}`);
  const period = parseInput(PeriodSpec, { kind: "relative", preset });

  const { dims, labels, currency, cpa, hasProjections } = await withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true, reportingCurrency: true } });
    const dimensions = await tx.dimension.findMany({ where: { orgId: ws.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, label: true } });
    const byKey = new Map(dimensions.map((d) => [d.key, d]));
    const pick = (...keys: string[]) => keys.map((k) => byKey.get(k)).find((d) => d !== undefined) ?? null;
    const rows = pick("country", "market", "region");
    const cols = pick("platform", "channel");
    const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: [rows?.id, cols?.id].filter((x): x is string => x !== undefined) } }, select: { dimensionId: true, code: true, label: true } });
    const label = (d: typeof rows) => Object.fromEntries(values.filter((v) => v.dimensionId === d?.id).map((v) => [v.code, v.label]));
    const metric = await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId: ws.orgId, key: "cpa" } }, select: { id: true } });
    // The projection measures are the planner's costly ones; ask for them only when there are projections.
    const [projection] = await tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one FROM projection_fact WHERE workspace_id = ${workspaceId}::uuid LIMIT 1`;
    return { dims: { rows, cols }, labels: { rows: label(rows), cols: label(cols) }, currency: ws.reportingCurrency, cpa: metric !== null, hasProjections: projection !== undefined };
  });

  const q = (body: Record<string, unknown>) => runQuery(prisma, auth, { workspaceId, period, filter: leaves, ...body });
  // Pace, not projection: pace index is spend so far against the phased plan, known from day one;
  // a projection exists only once projection facts are loaded.
  const PACE = ["budget", "actual", "pace_index", "spend_to_date_pct"];
  const rowKey = dims.rows?.key ?? "";
  const colKey = dims.cols?.key ?? "";
  // KPI targets sit on the market-level budgets (a market set, no platform): read them there.
  const marketLevel = { logic: "and" as const, children: [{ field: { kind: "dimension" as const, key: rowKey }, op: "not_empty" as const }, { field: { kind: "dimension" as const, key: colKey }, op: "is_empty" as const }, { field: { kind: "attr" as const, key: "status" as const }, op: "neq" as const, value: "ARCHIVED" }] };
  const [heat, over, under, kpi, kpiTargets, alerts, mine, sources, projected] = await Promise.all([
    dims.rows && dims.cols ? q({ groupBy: [rowKey, colKey], measures: ["budget", "actual", "pace_index", "spend_to_date_pct"], sort: [{ key: "budget", dir: "desc" }], limit: 1000 }) : null,
    q({ measures: PACE, sort: [{ key: "pace_index", dir: "desc" }], limit: 5 }),
    q({ measures: PACE, sort: [{ key: "pace_index", dir: "asc" }], limit: 5 }),
    dims.rows && cpa ? q({ groupBy: [rowKey], measures: ["budget", "actual"], targets: ["cpa"], sort: [{ key: "budget", dir: "desc" }], limit: 12 }) : null,
    dims.rows && dims.cols && cpa ? q({ filter: marketLevel, measures: ["budget"], targets: ["cpa"], limit: 200 }) : null,
    listAlerts(prisma, auth, { limit: 500 }),
    listApprovals(prisma, auth, { assignee: "me", status: "PENDING,ESCALATED", limit: "100" }),
    freshness(prisma, auth, workspaceId),
    hasProjections ? q({ measures: ["projected", "projected_close_pct"], limit: 1 }) : null,
  ]);

  const cells = (heat?.rows ?? []).map((r) => ({ row: r.dimensions[dims.rows?.key ?? ""] ?? null, col: r.dimensions[dims.cols?.key ?? ""] ?? null, ...r.measures }));
  const top = (key: "row" | "col", n: number) => [...new Set(cells.map((c) => c[key]).filter((v): v is string => v !== null))].slice(0, n); // already by budget, desc
  const variance = (res: QueryResponse, sign: 1 | -1) =>
    res.rows
      .filter((r) => r.measures["pace_index"] !== null && (Number(r.measures["pace_index"]) - 1) * sign > 0)
      .map((r) => ({ envelopeId: r.envelopeId, name: r.path.at(-1) ?? "", path: r.path, ...r.measures }));
  const targetOf = new Map((kpiTargets?.rows ?? []).map((r) => [r.dimensions[rowKey] ?? "", r.targets["cpa"]?.target ?? null]));
  // CPA: lower is better, so a positive gap is worse than target.
  const gap = (actual: string | null, target: string | null) => (actual === null || target === null || new Decimal(target).isZero() ? null : new Decimal(actual).div(target).minus(1).toDecimalPlaces(4).toString());
  const now = Date.now();
  const severities = ["critical", "warning", "info", "data"] as const;
  return {
    period: { preset },
    currency,
    dataAsOf: over.dataAsOf,
    totals: { ...(heat?.totals ?? over.totals), projected: projected?.totals["projected"] ?? null, projected_close_pct: projected?.totals["projected_close_pct"] ?? null },
    heatmap: dims.rows && dims.cols ? { rowDimension: { key: dims.rows.key, label: dims.rows.label }, colDimension: { key: dims.cols.key, label: dims.cols.label }, rows: top("row", 12), cols: top("col", 8), labels, cells } : null,
    variances: { over: variance(over, 1), under: variance(under, -1) },
    kpi: kpi && dims.rows
      ? {
          metric: "cpa",
          direction: "lower_is_better",
          dimension: { key: dims.rows.key, label: dims.rows.label },
          rows: kpi.rows.map((r) => {
            const code = r.dimensions[rowKey] ?? null;
            const actual = r.targets["cpa"]?.actual ?? null;
            const target = targetOf.get(code ?? "") ?? null;
            return { code, label: labels.rows[code ?? ""] ?? null, budget: r.measures["budget"] ?? null, actual: actual === null ? null : new Decimal(actual).toDecimalPlaces(2).toFixed(2), target, vsTargetPct: gap(actual, target) };
          }),
        }
      : null,
    alerts: {
      open: alerts.filter((a) => a.status === "OPEN").length,
      counts: Object.fromEntries(severities.map((s) => [s, alerts.filter((a) => a.status === "OPEN" && a.severity === s).length])),
      latest: alerts.filter((a) => a.status === "OPEN").slice(0, 5),
    },
    approvals: {
      mine: mine.rows.length,
      overdue: mine.rows.filter((r) => r["dueAt"] !== null && Date.parse(String(r["dueAt"])) < now).length,
      due: [...mine.rows].sort((a, b) => String(a["dueAt"] ?? "9").localeCompare(String(b["dueAt"] ?? "9"))).slice(0, 5),
    },
    freshness: sources,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** The latest fact date, and each source's last run: how fresh the actuals are (plan §11.1). */
async function freshness(prisma: PrismaClient, auth: AuthContext, workspaceId: string) {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const [last] = await tx.$queryRaw<Array<{ d: string | null }>>`SELECT max(period_date)::text AS d FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`;
    const sources = await tx.dataSource.findMany({ where: { workspaceId }, select: { id: true, name: true, kind: true, isActive: true }, orderBy: { name: "asc" } });
    const runs = await Promise.all(sources.map((s) => tx.ingestRun.findFirst({ where: { sourceId: s.id }, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true, rowsRejected: true, summary: true } })));
    return {
      lastFactDate: last?.d ?? null,
      sources: sources.map((s, i) => {
        const r = runs[i];
        const coverage = (r?.summary as { matchCoverage?: string } | null)?.matchCoverage ?? null;
        return { ...s, lastRun: r ? { status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, rowsRejected: r.rowsRejected, matchCoverage: coverage } : null };
      }),
    };
  });
}
