import { BaselineReportQuery, CreateBaselineInput, DomainError, QueryRequest, UpdateBaselineInput, can, newId, type BaselineReport, type BaselineScope, type BaselineView, type BaselinesResponse } from "@budget/domain";
import { audit, captureBaselineRows, comparedRows, outbox, subtreeIds, withTenant, type Tx } from "@budget/db";
import { compileQuery, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { BudgetBaseline, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * Snapshots (Phase E, ADR-053): saved by hand for the workspace, a filter's budgets or one budget
 * and everything under it. Each copies the approved amounts in force now and the structure as it
 * is (packages/db captureBaselineRows), in one transaction; it is never edited, only renamed or
 * archived. The change report compares a snapshot with now or with another snapshot.
 */
const WIDE = { start: "0001-01-01", end: "9999-12-31" };
const MAX_FILTER_ROWS = 50_000;
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Who may save or change a snapshot: finance and admins (`closure.close`) for the workspace or a
 * filter; for one budget's subtree, anyone who may edit that budget.
 */
async function assertMayManage(tx: Tx, auth: AuthContext, scope: BaselineScope): Promise<void> {
  if (auth.isOrgAdmin || can(auth.roles, "closure.close")) return;
  if ("envelopeId" in scope) {
    assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, scope.envelopeId));
    return;
  }
  throw new DomainError("FORBIDDEN", "Only finance and admins save snapshots of the whole workspace; save one of a budget from its drawer");
}

async function idsForFilter(tx: Tx, workspaceId: string, filter: unknown): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId, filter, period: { kind: "range", ...WIDE }, measures: ["budget"], limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, WIDE, new Date().toISOString().slice(0, 10));
    const page = pageOf(c, await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values), q.limit);
    ids.push(...page.rows.map((r) => String(r["envelope_id"])));
    if (ids.length > MAX_FILTER_ROWS) throw new DomainError("VALIDATION", "That filter covers too many budgets for one snapshot; save the whole workspace instead", { max: MAX_FILTER_ROWS });
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** The envelopes a scope covers today (null = the whole workspace). */
async function scopeIds(tx: Tx, workspaceId: string, scope: BaselineScope): Promise<string[] | null> {
  if ("envelopeId" in scope) {
    const ids = await subtreeIds(tx, scope.envelopeId);
    if (ids.length === 0) throw new DomainError("NOT_FOUND", "Budget not found");
    return ids;
  }
  if ("filter" in scope) return idsForFilter(tx, workspaceId, scope.filter);
  return null;
}

async function view(tx: Tx, b: BudgetBaseline): Promise<BaselineView> {
  const scope = (b.scope ?? {}) as Record<string, unknown>;
  const taker = await tx.user.findUnique({ where: { id: b.takenBy }, select: { id: true, name: true } });
  let scopeLabel: string | null = null;
  if (typeof scope["envelopeId"] === "string") {
    const e = await tx.envelope.findUnique({ where: { id: scope["envelopeId"] }, select: { name: true, displayName: true } });
    scopeLabel = e ? (e.displayName ?? e.name) : null;
  } else if (scope["filter"]) scopeLabel = "filter";
  return {
    id: b.id,
    name: b.name,
    kind: b.kind as BaselineView["kind"],
    scope,
    scopeLabel,
    periodKey: b.periodKey,
    asOf: b.asOf.toISOString(),
    note: b.note,
    takenBy: taker,
    createdAt: b.createdAt.toISOString(),
    archivedAt: b.archivedAt?.toISOString() ?? null,
    rowCount: b.rowCount,
    total: new Decimal(b.totalReporting.toString()).toFixed(2),
  };
}

/** POST /workspaces/:ws/baselines — one audit_event and one outbox row. */
export async function saveBaseline(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()): Promise<BaselineView> {
  const input = parseInput(CreateBaselineInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      await assertMayManage(tx, auth, input.scope);
      const ids = await scopeIds(tx, workspaceId, input.scope);
      const id = newId();
      // The header first (rows reference it), then the rows, then the counts they produced.
      await tx.budgetBaseline.create({ data: { id, workspaceId, name: input.name, kind: input.kind, scope: json(input.scope), periodKey: input.periodKey ?? null, asOf: now, note: input.note ?? null, takenBy: auth.user.id, rowCount: 0, totalReporting: 0 } });
      const { rows, total } = await captureBaselineRows(tx, { baselineId: id, workspaceId, asOf: now, envelopeIds: ids });
      const saved = await tx.budgetBaseline.update({ where: { id }, data: { rowCount: rows, totalReporting: total } });
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "baseline.saved", entityType: "budget_baseline", entityId: id, after: { name: input.name, kind: input.kind, scope: input.scope, rows, total }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "baseline.saved", payload: { baselineId: id, name: input.name, kind: input.kind, rows } });
      return view(tx, saved);
    },
    { timeoutMs: 120_000 },
  );
}

/** GET /workspaces/:ws/baselines — newest first; archived ones only when asked. */
export async function listBaselines(prisma: PrismaClient, auth: AuthContext, raw: { includeArchived?: string; envelopeId?: string } = {}): Promise<BaselinesResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.budgetBaseline.findMany({
      where: { workspaceId, ...(raw.includeArchived === "true" ? {} : { archivedAt: null }), ...(raw.envelopeId ? { rows: { some: { envelopeId: parseId(raw.envelopeId) } } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const views = await Promise.all(rows.map((b) => view(tx, b)));
    if (!raw.envelopeId) return { baselines: views };
    // One budget's drawer (Phase E4): what each snapshot holds for it.
    const envelopeId = parseId(raw.envelopeId);
    const held = new Map(
      (await tx.budgetBaselineRow.findMany({ where: { envelopeId, baselineId: { in: rows.map((b) => b.id) } }, select: { baselineId: true, versionId: true, amount: true, currency: true, name: true, parentId: true } })).map((r) => [
        r.baselineId,
        { versionId: r.versionId, amount: r.amount.toFixed(2), currency: r.currency, name: r.name, parentId: r.parentId },
      ]),
    );
    return { baselines: views.map((v) => ({ ...v, row: held.get(v.id) ?? null })) };
  });
}

/** PATCH /baselines/:id — rename, note, kind, archive; the rows never change. */
export async function updateBaseline(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown): Promise<BaselineView> {
  const id = parseId(rawId);
  const input = parseInput(UpdateBaselineInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await tx.budgetBaseline.findFirst({ where: { id, workspaceId } });
    if (before === null) throw new DomainError("NOT_FOUND", "Snapshot not found");
    await assertMayManage(tx, auth, (before.scope ?? {}) as BaselineScope);
    const saved = await tx.budgetBaseline.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    });
    const action = input.archived === true ? "baseline.archived" : input.archived === false ? "baseline.restored" : "baseline.updated";
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "budget_baseline", entityId: id, before: { name: before.name, kind: before.kind, note: before.note, archivedAt: before.archivedAt }, after: input, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "baseline.changed", payload: { baselineId: id, action } });
    return view(tx, saved);
  });
}

const pct = (abs: Decimal, base: Decimal) => (base.isZero() ? null : abs.div(base).toDecimalPlaces(4).toString());

/** GET /baselines/:id/report?against= — the snapshot against now, or against a second snapshot. */
export async function baselineReport(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown): Promise<BaselineReport> {
  const id = parseId(rawId);
  const q = parseInput(BaselineReportQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const b = await tx.budgetBaseline.findFirst({ where: { id, workspaceId } });
      if (b === null) throw new DomainError("NOT_FOUND", "Snapshot not found");
      const other = q.against ? await tx.budgetBaseline.findFirst({ where: { id: q.against, workspaceId } }) : null;
      if (q.against && other === null) throw new DomainError("NOT_FOUND", "The snapshot to compare with was not found");
      const scope = (b.scope ?? {}) as BaselineScope;
      const ids = other === null ? await scopeIds(tx, workspaceId, scope).catch((e: unknown) => (e instanceof DomainError && e.code === "NOT_FOUND" ? [] : Promise.reject(e))) : null;
      const rows = await comparedRows(tx, { baselineId: id, workspaceId, againstId: other?.id ?? null, scopeIds: ids });
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true, orgId: true } });

      // Totals: each side's roots (rows whose parent is not on that side), as in the Budgets headline.
      const onSide = (side: "baseline" | "now") => new Set(rows.filter((r) => r[side] !== null).map((r) => r.envelopeId));
      const total = (side: "baseline" | "now") => {
        const present = onSide(side);
        return rows.filter((r) => r[side] !== null && (r.parentId === null || !present.has(r.parentId))).reduce((s, r) => s.plus(r[side] ?? 0), new Decimal(0));
      };
      const baselineTotal = new Decimal(b.totalReporting.toString());
      const againstTotal = total("now");

      const counts = { increased: 0, decreased: 0, new: 0, removed: 0, ended: 0, unchanged: 0 };
      const movers: BaselineReport["topMovers"] = [];
      for (const r of rows) {
        const before = new Decimal(r.baseline ?? 0);
        const after = new Decimal(r.now ?? 0);
        const abs = after.minus(before);
        const status = r.baseline === null ? "new" : r.now === null ? "removed" : r.ended ? "ended" : "changed";
        if (status === "new") counts.new += 1;
        else if (status === "removed") counts.removed += 1;
        else if (status === "ended") counts.ended += 1;
        else if (abs.isZero()) counts.unchanged += 1;
        else if (abs.gt(0)) counts.increased += 1;
        else counts.decreased += 1;
        if (!abs.isZero() || status !== "changed") movers.push({ envelopeId: r.envelopeId, name: r.name, baseline: before.toFixed(2), now: after.toFixed(2), abs: abs.toFixed(2), pct: pct(abs, before), status });
      }
      movers.sort((x, y) => new Decimal(y.abs).abs().comparedTo(new Decimal(x.abs).abs()));

      // By granularity: the leaves' amounts grouped by each granularity's value (leaves never overlap).
      const byDimension: BaselineReport["byDimension"] = {};
      const leaves = rows.filter((r) => r.isLeaf);
      const keys = [...new Set(leaves.flatMap((r) => Object.keys(r.dimensionValues ?? {})))];
      const dims = keys.length ? await tx.dimension.findMany({ where: { orgId: ws.orgId, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true } }) : [];
      const values = dims.length ? await tx.dimensionValue.findMany({ where: { dimensionId: { in: dims.map((d) => d.id) } }, select: { dimensionId: true, code: true, label: true } }) : [];
      for (const key of keys) {
        const dim = dims.find((d) => d.key === key);
        const label = (code: string) => values.find((v) => v.dimensionId === dim?.id && v.code === code)?.label ?? code;
        const acc = new Map<string, { baseline: Decimal; now: Decimal }>();
        for (const r of leaves) {
          const code = r.dimensionValues?.[key];
          if (!code) continue;
          const cur = acc.get(code) ?? { baseline: new Decimal(0), now: new Decimal(0) };
          acc.set(code, { baseline: cur.baseline.plus(r.baseline ?? 0), now: cur.now.plus(r.now ?? 0) });
        }
        byDimension[key] = [...acc]
          .map(([code, v]) => ({ code, label: label(code), baseline: v.baseline.toFixed(2), now: v.now.toFixed(2), abs: v.now.minus(v.baseline).toFixed(2), pct: pct(v.now.minus(v.baseline), v.baseline) }))
          .sort((x, y) => new Decimal(y.abs).abs().comparedTo(new Decimal(x.abs).abs()))
          .slice(0, 12);
      }

      const change = againstTotal.minus(baselineTotal);
      return {
        baseline: { id: b.id, name: b.name, asOf: b.asOf.toISOString(), total: baselineTotal.toFixed(2) },
        against: other ? { kind: "baseline" as const, id: other.id, name: other.name, asOf: other.asOf.toISOString(), total: againstTotal.toFixed(2) } : { kind: "working" as const, id: null, name: "Now", asOf: new Date().toISOString(), total: againstTotal.toFixed(2) },
        change: { abs: change.toFixed(2), pct: pct(change, baselineTotal) },
        counts,
        byDimension,
        topMovers: movers.slice(0, q.limit),
        currency: ws.reportingCurrency,
      };
    },
    { timeoutMs: 60_000 },
  );
}

/** For the drawer's History: which snapshots saved each version of a budget. */
export async function snapshotsByVersion(tx: Tx, envelopeId: string): Promise<Map<string, Array<{ id: string; name: string; kind: string }>>> {
  const rows = await tx.budgetBaselineRow.findMany({ where: { envelopeId, versionId: { not: null } }, select: { versionId: true, baseline: { select: { id: true, name: true, kind: true, archivedAt: true } } } });
  const out = new Map<string, Array<{ id: string; name: string; kind: string }>>();
  for (const r of rows) {
    if (r.versionId === null || r.baseline.archivedAt !== null) continue;
    out.set(r.versionId, [...(out.get(r.versionId) ?? []), { id: r.baseline.id, name: r.baseline.name, kind: r.baseline.kind }]);
  }
  return out;
}
