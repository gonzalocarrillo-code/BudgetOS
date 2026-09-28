import { CreatePeriodInput, DomainError, GeneratePeriodsInput, UpdatePeriodInput, fiscalYearPeriods, newId, type PeriodRow } from "@budget/domain";
import { audit, outbox, withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { parseId, parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * The workspace's fiscal calendar (product feedback 7, ADR-041): its years, quarters and months as
 * defined (calendar or 4-4-5 / 4-5-4 / 5-4-4) and custom partitions. Every screen resolves "this
 * quarter" and period keys through these rows (`resolvePeriod(…, calendar)`). A period that has a
 * closure keeps its dates: the closure's report was frozen on them.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);

async function record(tx: Tx, auth: AuthContext, workspaceId: string, action: string, entityId: string, before: unknown, after: unknown) {
  await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "fiscal_period", entityId, before, after, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId, topic: "period.changed", payload: { periodId: entityId, action } });
}

/** Another period of the same kind (not custom) that overlaps: "this quarter" must stay one row. */
async function assertNoOverlap(tx: Tx, workspaceId: string, kind: string, start: string, end: string, exceptId?: string) {
  if (kind === "custom") return;
  const clash = await tx.fiscalPeriod.findFirst({ where: { workspaceId, kind, startDate: { lte: at(end) }, endDate: { gte: at(start) }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { key: true } });
  if (clash) throw new DomainError("CONFLICT", `Overlaps the ${kind} ${clash.key}`, { key: clash.key });
}

export async function listPeriods(prisma: PrismaClient, auth: AuthContext): Promise<PeriodRow[]> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const periods = await tx.fiscalPeriod.findMany({ where: { workspaceId }, orderBy: [{ startDate: "asc" }, { key: "asc" }] });
    const closures = await tx.periodClosure.findMany({ where: { workspaceId, periodId: { in: periods.map((p) => p.id) } }, orderBy: { closedAt: "desc" }, select: { id: true, periodId: true, status: true } });
    const latest = new Map<string, { id: string; status: string }>();
    for (const c of closures) if (!latest.has(c.periodId)) latest.set(c.periodId, { id: c.id, status: c.status });
    return periods.map((p) => ({ id: p.id, key: p.key, kind: p.kind, start: day(p.startDate), end: day(p.endDate), closure: latest.get(p.id) ?? null }));
  });
}

export async function createPeriod(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const input = parseInput(CreatePeriodInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    if (await tx.fiscalPeriod.findUnique({ where: { workspaceId_key: { workspaceId, key: input.key } } })) throw new DomainError("CONFLICT", `A period called ${input.key} exists`, { key: input.key });
    await assertNoOverlap(tx, workspaceId, input.kind, input.start, input.end);
    const p = await tx.fiscalPeriod.create({ data: { id: newId(), workspaceId, key: input.key, kind: input.kind, startDate: at(input.start), endDate: at(input.end) } });
    await record(tx, auth, workspaceId, "period.created", p.id, null, input);
    return { id: p.id, key: p.key, kind: p.kind, start: input.start, end: input.end, closure: null };
  });
}

/** The periods of a fiscal year in a pattern; keys that exist are left as they are. */
export async function generatePeriods(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const input = parseInput(GeneratePeriodsInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } });
    const wanted = fiscalYearPeriods(input.fiscalYear, ws.fiscalYearStartMonth, input.pattern);
    const rows = await tx.fiscalPeriod.findMany({ where: { workspaceId, key: { in: wanted.map((w) => w.key) } }, select: { key: true, startDate: true, endDate: true } });
    // A kept period with other dates would leave gaps or overlaps in the year: say which, create nothing.
    const differs = rows.filter((r) => {
      const w = wanted.find((x) => x.key === r.key);
      return w !== undefined && (w.start !== day(r.startDate) || w.end !== day(r.endDate));
    });
    if (differs.length) {
      throw new DomainError("CONFLICT", `${differs.map((d) => d.key).join(", ")} already exist${differs.length === 1 ? "s" : ""} with other dates: edit or delete ${differs.length === 1 ? "it" : "them"} first (a closed period keeps its dates)`, {
        periods: differs.map((d) => ({ key: d.key, start: day(d.startDate), end: day(d.endDate), wanted: wanted.find((w) => w.key === d.key) })),
      });
    }
    const existing = new Set(rows.map((p) => p.key));
    const created: string[] = [];
    for (const w of wanted.filter((x) => !existing.has(x.key))) {
      await assertNoOverlap(tx, workspaceId, w.kind, w.start, w.end);
      await tx.fiscalPeriod.create({ data: { id: newId(), workspaceId, key: w.key, kind: w.kind, startDate: at(w.start), endDate: at(w.end) } });
      created.push(w.key);
    }
    await record(tx, auth, workspaceId, "period.generated", workspaceId, null, { ...input, created, kept: [...existing] });
    return { created, kept: [...existing] };
  });
}

async function editable(tx: Tx, id: string) {
  const p = await tx.fiscalPeriod.findUnique({ where: { id } });
  if (p === null) throw new DomainError("NOT_FOUND", "Period not found", { id });
  if (await tx.periodClosure.findFirst({ where: { periodId: id }, select: { id: true } })) throw new DomainError("CONFLICT", `${p.key} has a closure: its dates are frozen in the closure report`, { key: p.key });
  return p;
}

export async function updatePeriod(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdatePeriodInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const p = await editable(tx, id);
    const next = { key: input.key ?? p.key, start: input.start ?? day(p.startDate), end: input.end ?? day(p.endDate) };
    if (next.start > next.end) throw new DomainError("VALIDATION", "A period starts on or before it ends");
    if (next.key !== p.key && (await tx.fiscalPeriod.findUnique({ where: { workspaceId_key: { workspaceId: p.workspaceId, key: next.key } } }))) throw new DomainError("CONFLICT", `A period called ${next.key} exists`);
    await assertNoOverlap(tx, p.workspaceId, p.kind, next.start, next.end, p.id);
    await tx.fiscalPeriod.update({ where: { id }, data: { key: next.key, startDate: at(next.start), endDate: at(next.end) } });
    await record(tx, auth, p.workspaceId, "period.updated", id, { key: p.key, start: day(p.startDate), end: day(p.endDate) }, next);
    return { id, kind: p.kind, ...next, closure: null };
  });
}

export async function deletePeriod(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const p = await editable(tx, id);
    if (await tx.envelope.findFirst({ where: { periodId: id }, select: { id: true } })) throw new DomainError("CONFLICT", `Budgets are aligned to ${p.key}`, { key: p.key });
    await tx.fiscalPeriod.delete({ where: { id } });
    await record(tx, auth, p.workspaceId, "period.deleted", id, { key: p.key, kind: p.kind, start: day(p.startDate), end: day(p.endDate) }, null);
    return { id, deleted: true };
  });
}

/** GET /workspaces/:ws/fiscal-year: the month the fiscal year starts in. */
export async function getFiscalYearStart(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => ({ startMonth: (await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } })).fiscalYearStartMonth }));
}

/** PATCH /workspaces/:ws/fiscal-year: the month the fiscal year starts in (computed periods follow; rows stay). */
export async function setFiscalYearStart(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const { startMonth } = parseInput(z.object({ startMonth: z.number().int().min(1).max(12) }), raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } });
    await tx.workspace.update({ where: { id: workspaceId }, data: { fiscalYearStartMonth: startMonth } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.fiscal_year_changed", entityType: "workspace", entityId: workspaceId, before: { startMonth: ws.fiscalYearStartMonth }, after: { startMonth }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "registry.changed", payload: { kind: "fiscal_year", startMonth } });
    return { startMonth };
  });
}
