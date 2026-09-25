import { CloseInput, DomainError, fiscalPeriodKind, newId, resolvePeriod, type ClosureView } from "@budget/domain";
import { audit, bumpDataVersion, lockPeriodEnvelopes, outbox, withTenant, type Tx } from "@budget/db";
import { templateNodes } from "@budget/workers";
import { Decimal } from "decimal.js";
import type { FiscalPeriod, PeriodClosure, Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import type { ClosureRow, ClosureSink } from "../sink.js";

/**
 * POST /workspaces/:ws/closures (spec §15, ADR-018), one transaction: lock the live envelopes that
 * overlap the period (versions untouched), snapshot the registry versions, compute every hierarchy
 * template's nodes with the planner for the period and for each of its months, store the variance
 * summary, audit `closure.created`, outbox `period.closed`, and write the rows to the closure sink
 * last, so a sink failure rolls the whole close back.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** `closures.budget_vs_actual_<workspace>_<period>`, `_r<N>` from the second closure of a period on. */
export function closureTable(workspaceId: string, periodKey: string, revision: number): string {
  const base = `budget_vs_actual_${workspaceId.replace(/-/g, "_")}_${periodKey.replace(/-/g, "_").toLowerCase()}`;
  return revision === 0 ? base : `${base}_r${revision}`;
}

/** Calendar months overlapping [start, end], clipped to it. */
export function monthsOf(period: { start: string; end: string }): Array<{ month: string; start: string; end: string }> {
  const out: Array<{ month: string; start: string; end: string }> = [];
  for (let d = new Date(`${period.start.slice(0, 7)}-01T00:00:00Z`); iso(d) <= period.end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const last = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    out.push({ month: iso(d), start: iso(d) < period.start ? period.start : iso(d), end: last > period.end ? period.end : last });
  }
  return out;
}

export function closureView(c: PeriodClosure, p: FiscalPeriod, lockedEnvelopes: number): ClosureView {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    period: { id: p.id, key: p.key, kind: p.kind, start: iso(p.startDate), end: iso(p.endDate) },
    status: c.status as ClosureView["status"],
    closedBy: c.closedBy,
    closedAt: c.closedAt.toISOString(),
    table: `closures.${c.bqTable}`,
    lockedEnvelopes,
  };
}

async function resolveFiscalPeriod(tx: Tx, workspaceId: string, input: CloseInput, today: string): Promise<FiscalPeriod> {
  if (input.periodId !== undefined) {
    const p = await tx.fiscalPeriod.findUnique({ where: { id: input.periodId } });
    if (p === null || p.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Fiscal period not found");
    return p;
  }
  const key = input.periodKey as string;
  const existing = await tx.fiscalPeriod.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
  if (existing) return existing;
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } });
  const range = resolvePeriod({ kind: "fiscal", key }, today, ws.fiscalYearStartMonth);
  return tx.fiscalPeriod.create({ data: { id: newId(), workspaceId, key, kind: fiscalPeriodKind(key), startDate: new Date(`${range.start}T00:00:00Z`), endDate: new Date(`${range.end}T00:00:00Z`) } });
}

async function registrySnapshot(tx: Tx, orgId: string, workspaceId: string) {
  const dims = await tx.dimension.findMany({ where: { orgId, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, version: true } });
  const templates = await tx.hierarchyTemplate.findMany({ where: { workspaceId }, select: { id: true, version: true } });
  return { dimensions: Object.fromEntries(dims.map((d) => [d.key, d.version])), templates: Object.fromEntries(templates.map((t) => [t.id, t.version])) };
}

export async function closePeriod(prisma: PrismaClient, sink: ClosureSink | null, auth: AuthContext, raw: unknown, now: Date = new Date()) {
  const input = parseInput(CloseInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  if (sink === null) throw new DomainError("UNAVAILABLE", "No closure sink is configured in this environment (BigQuery)");
  const today = iso(now);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const period = await resolveFiscalPeriod(tx, workspaceId, input, today);
      const range = { start: iso(period.startDate), end: iso(period.endDate) };
      if (range.end >= today) throw new DomainError("CONFLICT", `Period ${period.key} has not ended (ends ${range.end})`, { periodEnd: range.end });
      const earlier = await tx.periodClosure.findMany({ where: { workspaceId, periodId: period.id }, select: { status: true } });
      if (earlier.some((c) => c.status === "closed")) throw new DomainError("CONFLICT", `Period ${period.key} is already closed; restate it first`);
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } });

      const table = closureTable(workspaceId, period.key, earlier.length);
      const closure = await tx.periodClosure.create({
        data: { id: newId(), workspaceId, periodId: period.id, status: "closed", closedBy: auth.user.id, closedAt: now, registryVersion: await registrySnapshot(tx, auth.user.orgId, workspaceId), bqTable: table, varianceSummary: {} },
      });
      const locked = await lockPeriodEnvelopes(tx, closure.id, workspaceId, range);

      // Every template's tree for the period and for each month of it, from the planner.
      const ctx = { workspaceId, orgId: auth.user.orgId, today };
      const templates = await tx.hierarchyTemplate.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
      const months = monthsOf(range);
      const base = { closure_id: closure.id, workspace_id: workspaceId, period_key: period.key, period_start: range.start, period_end: range.end, currency: ws.reportingCurrency, closed_at: now.toISOString() };
      const rows: ClosureRow[] = [];
      const byTemplate: Array<Record<string, unknown>> = [];
      let totals: Record<string, string | null> | null = null;
      const monthly = new Map<string, { actual: Decimal; projected: Decimal }>();
      for (const t of templates) {
        const nodes = await templateNodes(tx, ctx, t, range);
        for (const n of nodes) {
          const m = n.measures;
          rows.push({
            ...base,
            template_id: t.id,
            template_name: t.name,
            grain: "total",
            month: null,
            node_path: n.nodePath,
            depth: n.nodePath === "" ? 0 : n.nodePath.split("/").length,
            envelope_id: n.envelopeId,
            budget: money(m["budget"]),
            actual: money(m["actual"]),
            projected: money(m["projected"]),
            remaining: money(m["remaining"]),
            pace_index: text(m["pace_index"]),
            spend_to_date_pct: text(m["spend_to_date_pct"]),
            projected_close_pct: text(m["projected_close_pct"]),
            leaf_count: Number(m["leafCount"] ?? 0),
          });
        }
        const root = nodes[0]?.measures ?? {};
        totals ??= { budget: money(root["budget"]), actual: money(root["actual"]), projected: money(root["projected"]), remaining: money(root["remaining"]) };
        const top = nodes.filter((n) => n.nodePath !== "" && !n.nodePath.includes("/"));
        byTemplate.push({
          templateId: t.id,
          name: t.name,
          path: t.path,
          nodes: nodes.length,
          top: top.map((n) => {
            const budget = new Decimal(String(n.measures["budget"] ?? 0));
            const actual = new Decimal(String(n.measures["actual"] ?? 0));
            return { nodePath: n.nodePath, budget: budget.toFixed(2), actual: actual.toFixed(2), variance: actual.minus(budget).toFixed(2), variancePct: budget.isZero() ? null : actual.minus(budget).div(budget).toDecimalPlaces(4).toString() };
          }),
        });
        // Months: actual and projected per node. The planner's budget is the whole envelope amount
        // (it has no phased grain), so month rows carry no budget (ADR-018).
        for (const mo of months) {
          for (const n of await templateNodes(tx, ctx, t, mo)) {
            if (n.nodePath === "" && !monthly.has(mo.month)) monthly.set(mo.month, { actual: new Decimal(String(n.measures["actual"] ?? 0)), projected: new Decimal(String(n.measures["projected"] ?? 0)) });
            rows.push({
              ...base,
              template_id: t.id,
              template_name: t.name,
              grain: "month",
              month: mo.month,
              node_path: n.nodePath,
              depth: n.nodePath === "" ? 0 : n.nodePath.split("/").length,
              envelope_id: n.envelopeId,
              budget: null,
              actual: money(n.measures["actual"]),
              projected: money(n.measures["projected"]),
              remaining: null,
              pace_index: null,
              spend_to_date_pct: null,
              projected_close_pct: null,
              leaf_count: Number(n.measures["leafCount"] ?? 0),
            });
          }
        }
      }
      const budget = new Decimal(totals?.["budget"] ?? 0);
      const actual = new Decimal(totals?.["actual"] ?? 0);
      const summary = {
        period: { key: period.key, start: range.start, end: range.end },
        currency: ws.reportingCurrency,
        lockedEnvelopes: locked.length,
        rows: rows.length,
        totals: totals === null ? null : { ...totals, variance: actual.minus(budget).toFixed(2), variancePct: budget.isZero() ? null : actual.minus(budget).div(budget).toDecimalPlaces(4).toString() },
        months: [...monthly].map(([month, m]) => ({ month, actual: m.actual.toFixed(2), projected: m.projected.toFixed(2) })),
        byTemplate,
      };
      const saved = await tx.periodClosure.update({ where: { id: closure.id }, data: { varianceSummary: summary as Prisma.InputJsonObject } });
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "closure.created", entityType: "period_closure", entityId: closure.id, after: { periodKey: period.key, table, lockedEnvelopes: locked.length, rows: rows.length }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "period.closed", payload: { closureId: closure.id, periodId: period.id, periodKey: period.key, table, lockedEnvelopes: locked.length } });
      await bumpDataVersion(tx, workspaceId);
      await sink.write(table, rows);
      return closureView(saved, period, locked.length);
    },
    { timeoutMs: 300_000 },
  );
}
