import { DomainError, FilterGroup, ListAlertsQuery, PeriodSpec, QueryRequest, canInScope, resolvePeriod, type FilterGroupT } from "@budget/domain";
import { plannerOptions, withTenant, type Tx } from "@budget/db";
import { compileQuery, compileTotals, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import { envelopeScopeTargets } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";
import { alertView } from "./rules.js";

type Row = Record<string, unknown>;
const WIDE = { start: "0001-01-01", end: "9999-12-31" };
const today = () => new Date().toISOString().slice(0, 10);

/** A `filter` query parameter: a FilterGroup as JSON (URL-encoded), validated at the boundary. */
export function parseFilterParam(raw: string | undefined): FilterGroupT | undefined {
  if (raw === undefined || raw === "") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DomainError("VALIDATION", "filter must be a FilterGroup as JSON");
  }
  return parseInput(FilterGroup, json);
}

/** `period` query parameter: a preset name (current_quarter …) or a PeriodSpec as JSON. */
function parsePeriodParam(raw: string | undefined): PeriodSpec {
  if (raw === undefined || raw === "") return { kind: "relative", preset: "current_year" };
  if (/^[a-z_0-9]+$/.test(raw)) return parseInput(PeriodSpec, { kind: "relative", preset: raw });
  try {
    return parseInput(PeriodSpec, JSON.parse(raw));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("VALIDATION", "period must be a preset name or a PeriodSpec as JSON");
  }
}

async function envelopeIdsFor(tx: Tx, workspaceId: string, filter: FilterGroupT): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId, filter, period: { kind: "range", ...WIDE }, measures: ["budget"], limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, WIDE, today());
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
    for (const r of page.rows) ids.add(String(r["envelope_id"]));
    if (ids.size > 50_000) throw new DomainError("VALIDATION", "filter selects too many envelopes");
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** GET /alerts?status&severity&ruleId&envelopeId&filter&limit: newest first; alerts outside the caller's scope are left out. */
export async function listAlerts(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListAlertsQuery, raw ?? {});
  const filter = parseFilterParam(q.filter);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const statuses = (q.status ?? "OPEN,ACKNOWLEDGED,SNOOZED").split(",") as Array<"OPEN" | "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED">;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const inFilter = filter ? await envelopeIdsFor(tx, workspaceId, filter) : null;
    const rows = await tx.alert.findMany({
      where: {
        workspaceId,
        status: { in: statuses },
        ...(q.severity ? { severity: q.severity } : {}),
        ...(q.ruleId ? { ruleId: q.ruleId } : {}),
        ...(q.envelopeId ? { envelopeId: q.envelopeId } : inFilter ? { envelopeId: { in: [...inFilter] } } : {}),
      },
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      take: q.limit,
    });
    const scopes = await envelopeScopeTargets(tx, [...new Set(rows.map((a) => a.envelopeId))]);
    const visible = rows.filter((a) => auth.isOrgAdmin || canInScope(auth.assignments, "envelope.read", scopes.get(a.envelopeId) ?? { dims: {} }));
    // Names for the alerts screen (T-032): which budget, which rule and what it measures.
    const envelopes = new Map((await tx.envelope.findMany({ where: { id: { in: [...new Set(visible.map((a) => a.envelopeId))] } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    const rules = new Map((await tx.pacingRule.findMany({ where: { id: { in: [...new Set(visible.map((a) => a.ruleId))] } }, select: { id: true, name: true, metric: true, comparator: true } })).map((r) => [r.id, r]));
    return visible.map((a) => {
      const rule = rules.get(a.ruleId);
      return { ...alertView(a), envelopeName: envelopes.get(a.envelopeId) ?? null, ruleName: rule?.name ?? null, metric: rule?.metric ?? null, comparator: rule?.comparator ?? null };
    });
  });
}

/**
 * GET /workspaces/:ws/pacing?filter&period: pace measures per envelope from the planner plus the
 * open alert count, and totals (ratios recomputed from sums). Default period: the fiscal year.
 */
export async function pacingView(prisma: PrismaClient, auth: AuthContext, query: { filter?: string | undefined; period?: string | undefined; cursor?: string | undefined; limit?: string | undefined }) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const filter = parseFilterParam(query.filter);
  const spec = parsePeriodParam(query.period);
  const limit = query.limit === undefined ? 200 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DomainError("VALIDATION", "limit must be 1..1000");
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } });
    const day = today();
    const period = resolvePeriod(spec, day, ws.fiscalYearStartMonth);
    const q = QueryRequest.parse({
      workspaceId,
      ...(filter ? { filter } : {}),
      measures: ["budget", "actual", "projected", "pace_index", "spend_to_date_pct", "projected_close_pct"],
      targets: ["cpa"],
      period: { kind: "range", ...period },
      limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId }, q.targets, period);
    const hasCpa = opts.metrics?.has("cpa") ?? false;
    const req = hasCpa ? q : { ...q, targets: [] };
    const c = compileQuery(req, period, day, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), limit);
    const t = compileTotals(req, period, day, opts);
    const [totals] = await tx.$queryRawUnsafe<Row[]>(t.sql, ...t.values);
    const scopes = await envelopeScopeTargets(tx, page.rows.map((r) => String(r["envelope_id"])));
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
    const MONEY = new Set(["budget", "actual", "projected"]);
    return {
      period,
      rows: page.rows
        .filter((r) => auth.isOrgAdmin || canInScope(auth.assignments, "envelope.read", scopes.get(String(r["envelope_id"])) ?? { dims: {} }))
        .map((r) => ({
          envelopeId: String(r["envelope_id"]),
          name: String(r["name"]),
          status: String(r["status"]),
          budget: money(r["budget"]),
          actual: money(r["actual"]),
          projected: money(r["projected"]),
          paceIndex: text(r["pace_index"]),
          spendToDatePct: text(r["spend_to_date_pct"]),
          projectedClosePct: text(r["projected_close_pct"]),
          cpa: hasCpa ? { actual: text(r["kpi_cpa"]), target: text(r["tgt_cpa"]), vsTargetPct: text(r["vs_cpa"]) } : null,
          openAlerts: Number(r["open_alerts"] ?? 0),
        })),
      totals: Object.fromEntries(Object.entries(totals ?? {}).map(([k, v]) => [k, MONEY.has(k) ? money(v) : text(v)])),
      nextCursor: page.nextCursor,
    };
  });
}
