import { CloseInput, DomainError, factsPrunedBefore, fiscalPeriodKind, newId, readsPrunedFacts, resolvePeriod } from "@budget/domain";
import { audit, bumpDataVersion, lockClosure, lockPeriodEnvelopes, outbox, withTenant, type Tx } from "@budget/db";
import { templateNodes } from "@budget/workers";
import { Decimal } from "decimal.js";
import type { FiscalPeriod, Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import type { ClosureRow, ClosureSink } from "../sink.js";
import { closureView } from "../views.js";
import { failClosure } from "./fail-closure.js";

/**
 * POST /workspaces/:ws/closures (spec §15, ADR-018 and its W3-1 addendum), two transactions with the
 * closure sink between them, so no row lock is held across BigQuery I/O (audit I-4):
 * 1. Lock the live envelopes that overlap the period (versions untouched), snapshot the registry
 *    versions, compute every hierarchy template's nodes with the planner for the period and for
 *    each of its months, store the variance summary on a `closing` closure, audit
 *    `closure.started`, outbox `period.closing`, bump the data version, commit.
 * 2. Write the rows to `closures.closure_<closure id>` outside any transaction.
 * 3. Flip the closure to `closed` with audit `closure.created` and outbox `period.closed`; or, when
 *    the sink failed, to `failed` with its envelopes unlocked (`fail-closure.ts`), and rethrow.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * `closures.closure_<closure id without dashes>`: one table per closure attempt, so a failed attempt's
 * leftover table never blocks the next close of the period (W3-1; it used to be named by the count
 * of earlier closures, `budget_vs_actual_<workspace>_<period>[_r<N>]`).
 */
export function closureTable(closureId: string): string {
  return `closure_${closureId.replace(/-/g, "")}`;
}

interface StartedClose {
  closureId: string;
  periodId: string;
  periodKey: string;
  table: string;
  rows: ClosureRow[];
  lockedEnvelopes: number;
}

/** What the caller sees when the sink fails: its DomainError, BigQuery's 409 as CONFLICT, anything else 503. */
function sinkError(e: unknown, table: string): DomainError {
  if (e instanceof DomainError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if ((e as { code?: unknown } | null)?.code === 409) return new DomainError("CONFLICT", `Closure table ${table}: ${message}`, { table });
  return new DomainError("UNAVAILABLE", `The closure rows could not be written to ${table}: ${message}`, { table });
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
  const started = await startClose(prisma, auth, workspaceId, input, now);
  try {
    // The table is this closing closure's own: if an earlier write of it left it half-written, replace it.
    await sink.write(started.table, started.rows, { replace: true });
  } catch (e) {
    const err = sinkError(e, started.table);
    try {
      await withTenant(prisma, auth.ctx, async (tx) => {
        if (!(await lockClosure(tx, started.closureId))) return;
        const current = await tx.periodClosure.findUniqueOrThrow({ where: { id: started.closureId } });
        if (current.status === "closing") await failClosure(tx, auth, current, err.message, "closure.failed");
      });
    } catch (cleanup) {
      // The closure stays `closing` until it is abandoned (runbook); the caller still gets the sink's error.
      err.details = { ...err.details, closureId: started.closureId, cleanupError: cleanup instanceof Error ? cleanup.message : String(cleanup) };
    }
    throw err;
  }
  return withTenant(prisma, auth.ctx, async (tx) => {
    if (!(await lockClosure(tx, started.closureId))) throw new DomainError("NOT_FOUND", "Closure not found");
    const current = await tx.periodClosure.findUniqueOrThrow({ where: { id: started.closureId } });
    // Abandoned (stale) while the rows were being written: it stays failed; the table is an orphan named by its id.
    if (current.status !== "closing") throw new DomainError("CONFLICT", `The close of ${started.periodKey} was abandoned while its rows were being written; close the period again`, { closureId: started.closureId, status: current.status });
    const saved = await tx.periodClosure.update({ where: { id: started.closureId }, data: { status: "closed", closedAt: new Date() } });
    const { closureId, periodId, periodKey, table, lockedEnvelopes } = started;
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "closure.created", entityType: "period_closure", entityId: closureId, before: { status: "closing" }, after: { status: "closed", periodKey, table, lockedEnvelopes, rows: started.rows.length }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "period.closed", payload: { closureId, periodId, periodKey, table, lockedEnvelopes } });
    const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: periodId } });
    return closureView(saved, period, lockedEnvelopes);
  });
}

/** Transaction 1: validate, lock, compute, and commit the closure as `closing`. */
async function startClose(prisma: PrismaClient, auth: AuthContext, workspaceId: string, input: CloseInput, now: Date): Promise<StartedClose> {
  const today = iso(now);
  try {
    return await withTenant(
      prisma,
      auth.ctx,
      async (tx) => {
        const period = await resolveFiscalPeriod(tx, workspaceId, input, today);
        const range = { start: iso(period.startDate), end: iso(period.endDate) };
        if (range.end >= today) throw new DomainError("CONFLICT", `Period ${period.key} has not ended (ends ${range.end})`, { periodEnd: range.end });
        const earlier = await tx.periodClosure.findMany({ where: { workspaceId, periodId: period.id }, select: { id: true, status: true } });
        if (earlier.some((c) => c.status === "closed")) throw new DomainError("CONFLICT", `Period ${period.key} is already closed; restate it first`);
        const inProgress = earlier.find((c) => c.status === "closing");
        if (inProgress) throw new DomainError("CONFLICT", `Period ${period.key} is being closed (closure in progress)`, { closureId: inProgress.id });
        const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true, settings: true } });
        // D-002: a close freezes actuals; over months kept in BigQuery only it would freeze none.
        const prunedBefore = factsPrunedBefore(ws.settings);
        if (readsPrunedFacts(range, prunedBefore)) throw new DomainError("CONFLICT", `Period ${period.key} starts before ${prunedBefore}; its spend is kept in BigQuery only`, { factsPrunedBefore: prunedBefore });

        const id = newId();
        const table = closureTable(id);
        // The partial unique index period_closure_one_closed covers `closing` too: a concurrent close
        // of this period waits here and then fails with P2002 (409 below).
        const closure = await tx.periodClosure.create({
          data: { id, workspaceId, periodId: period.id, status: "closing", closedBy: auth.user.id, closedAt: now, registryVersion: await registrySnapshot(tx, auth.user.orgId, workspaceId), bqTable: table, varianceSummary: {} },
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
          // D-1 (audit T-12, ADR-0076, ADR-059): `templateNodes` above is called with no `unallocated`
          // option, so its budget is the sum of live leaves, not the holdings basis Budgets/tree use.
          // Recorded here so the frozen report stays legible after readers forget which basis is current.
          basis: { budget: "live_leaves" as const, note: "Sum of approved leaf budgets live in the period; Budgets/tree use holdings (ADR-059), which also count unsplit parent money." },
        };
        await tx.periodClosure.update({ where: { id: closure.id }, data: { varianceSummary: summary as Prisma.InputJsonObject } });
        await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "closure.started", entityType: "period_closure", entityId: closure.id, after: { status: "closing", periodKey: period.key, table, lockedEnvelopes: locked.length, rows: rows.length }, requestId: auth.ctx.requestId });
        await outbox(tx, { workspaceId, topic: "period.closing", payload: { closureId: closure.id, periodId: period.id, periodKey: period.key, table, lockedEnvelopes: locked.length } });
        // Last statement: the workspace row is locked only until this commit (audit I-4, I-14).
        await bumpDataVersion(tx, workspaceId);
        return { closureId: closure.id, periodId: period.id, periodKey: period.key, table, rows, lockedEnvelopes: locked.length };
      },
      { timeoutMs: 300_000 },
    );
  } catch (e) {
    // A concurrent close of the same period won the race (period_closure_one_closed, or the
    // fiscal_period row both tried to create).
    if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This period is being closed by another request (closure in progress)");
    throw e;
  }
}
