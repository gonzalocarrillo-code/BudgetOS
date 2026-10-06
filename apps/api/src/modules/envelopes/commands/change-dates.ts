import { ChangeDatesInput, DomainError, rephase, type DateChangeLine, type DateChangePreview } from "@budget/domain";
import { applyDates, audit, lockEnvelope, lockEnvelopes, outbox, withTenant, type BulkDatesLine, type LockedEnvelopeRow, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { routeStructural } from "./structure.js";
import { assertBasedOnHead, assertNotHeld, lockForWrite, writeDraftVersion, type PhasingRow } from "./version-writer.js";

/**
 * Changing a budget's dates (ADR-060, product feedback 2026-09-29).
 *
 * - A budget with an approved amount changes through its approval policy, like an early end: each
 *   budget that moves gets a new version with the same amount and its phasing re-spread into the
 *   new dates, and the dates apply when the request is approved. The policy reads the share of the
 *   budget whose days move as the change, so a one-day extension is minor and a shifted quarter is not.
 * - A budget never approved changes at once.
 * - The new dates must fit inside the parent's. Children that would fall outside are listed first
 *   and trimmed only with `trimChildren`; a child entirely outside the new dates must move first.
 * - W3-5: every budget the change moves is held until the request is decided, and the approval
 *   checks all of the above again (approvals/revalidate-dates.ts) before it writes any date.
 */

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);
const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** First-of-month dates from the start's month to the end's. */
function monthsOf(start: string, end: string): string[] {
  const out: string[] = [];
  const last = monthOf(end);
  for (let m = monthOf(start); m <= last; ) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  }
  return out;
}

/**
 * A phasing moved into new dates, summing to the same amount. Months still inside keep their
 * shape (scaled back to the amount when some drop out); when none is left, the amount spreads over
 * the new months by their days in the range. No phasing stays none.
 */
export function respread(phasing: Array<{ month: string; amount: Decimal }>, amount: Decimal, range: { startDate: string; endDate: string }): PhasingRow[] | undefined {
  if (phasing.length === 0) return undefined;
  const months = new Set(monthsOf(range.startDate, range.endDate));
  const kept = phasing.filter((p) => months.has(p.month));
  const shape = kept.some((p) => !p.amount.isZero())
    ? kept
    : [...months].map((m) => ({ month: m, amount: new Decimal(days(later(m, range.startDate), earlier(monthEnd(m), range.endDate))) }));
  return rephase(shape, amount).map((p) => ({ month: p.month, amount: p.amount.toFixed(2) }));
}

interface Line extends DateChangeLine {
  env: LockedEnvelopeRow & { name: string; parentId: string | null };
}

interface Plan {
  lines: Line[];
  outside: Line[];
  needsApproval: boolean;
  movedShare: Decimal;
}

async function lockNamed(tx: Tx, id: string) {
  const env = await lockEnvelope(tx, id);
  if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
  const row = await tx.envelope.findUniqueOrThrow({ where: { id }, select: { name: true, displayName: true, parentId: true } });
  return { ...env, name: row.displayName ?? row.name, parentId: row.parentId };
}

/**
 * W3-5 lock order (structure.ts): the budget, its parent and every budget under it, by id, before
 * any other lock, so a date change and a move or a decision on the same family wait for each other
 * instead of deadlocking. A budget moved in after this read is locked when it is reached.
 */
async function lockFamily(tx: Tx, envelopeId: string): Promise<void> {
  const root = await tx.envelope.findUnique({ where: { id: envelopeId }, select: { parentId: true } });
  if (root === null) return; // lockForWrite says NOT_FOUND
  const ids = [envelopeId, ...(root.parentId === null ? [] : [root.parentId])];
  let frontier = [envelopeId];
  for (let depth = 0; frontier.length > 0 && depth < 64; depth += 1) {
    frontier = (await tx.envelope.findMany({ where: { parentId: { in: frontier }, status: { not: "ARCHIVED" } }, select: { id: true } })).map((k) => k.id);
    ids.push(...frontier);
  }
  await lockEnvelopes(tx, [...new Set(ids)]);
}

async function planDates(tx: Tx, auth: AuthContext, envelopeId: string, input: ChangeDatesInput): Promise<Plan> {
  await lockFamily(tx, envelopeId);
  const locked = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
  assertBasedOnHead(locked, input.basedOnVersionId);
  await assertNotHeld(tx, [envelopeId]);
  const root = await lockNamed(tx, envelopeId);
  const to = { startDate: input.startDate, endDate: input.endDate };
  if (to.startDate === root.startDate && to.endDate === root.endDate) throw new DomainError("VALIDATION", "These are already the budget's dates");
  if (root.parentId !== null) {
    const parent = await tx.envelope.findUnique({ where: { id: root.parentId }, select: { name: true, displayName: true, status: true, startDate: true, endDate: true } });
    const ps = parent?.startDate.toISOString().slice(0, 10) ?? "";
    const pe = parent?.endDate.toISOString().slice(0, 10) ?? "";
    if (parent && parent.status !== "ARCHIVED" && (to.startDate < ps || to.endDate > pe)) {
      throw new DomainError("VALIDATION", `${parent.displayName ?? parent.name} runs ${ps} – ${pe}; change its dates first`, { parentId: root.parentId, startDate: ps, endDate: pe });
    }
  }
  const lines: Line[] = [{ envelopeId, name: root.name, from: { startDate: root.startDate, endDate: root.endDate }, to, rephased: false, env: root }];
  const outside: Line[] = [];
  // Parents first: each child is trimmed to its parent's new dates, its own children to its own.
  const queue = [{ id: envelopeId, range: to }];
  while (queue.length > 0) {
    const { id, range } = queue.shift() as { id: string; range: { startDate: string; endDate: string } };
    const kids = await tx.envelope.findMany({ where: { parentId: id, status: { not: "ARCHIVED" } }, select: { id: true }, orderBy: { name: "asc" } });
    for (const k of kids) {
      const child = await lockNamed(tx, k.id);
      const next = { startDate: later(child.startDate, range.startDate), endDate: earlier(child.endDate, range.endDate) };
      if (next.startDate === child.startDate && next.endDate === child.endDate) continue; // fits, and so does everything under it
      if (next.startDate > next.endDate) {
        throw new DomainError("CONFLICT", `${child.name} runs ${child.startDate} – ${child.endDate}, outside the new dates; move or end it first`, { envelopeId: child.id });
      }
      if (child.endedAt) throw new DomainError("CONFLICT", `${child.name} has ended and keeps its dates; the new dates must include ${child.startDate} – ${child.endDate}`, { envelopeId: child.id });
      const line = { envelopeId: child.id, name: child.name, from: { startDate: child.startDate, endDate: child.endDate }, to: next, rephased: false, env: child };
      lines.push(line);
      outside.push(line);
      queue.push({ id: child.id, range: next });
    }
  }
  // A child the change would trim, held by another open request, keeps its dates until that is decided.
  if (lines.length > 1) await assertNotHeld(tx, lines.slice(1).map((l) => l.envelopeId));
  const oldDays = days(root.startDate, root.endDate);
  const newDays = days(to.startDate, to.endDate);
  const overlap = Math.max(0, days(later(root.startDate, to.startDate), earlier(root.endDate, to.endDate)));
  const movedShare = new Decimal(1).minus(new Decimal(overlap).div(Math.max(oldDays, newDays)));
  // Any budget here with an approved amount makes the whole change go through approval.
  return { lines, outside, needsApproval: lines.some((l) => l.env.currentVersionId !== null), movedShare };
}

async function phasingOf(tx: Tx, versionId: string) {
  return (await tx.envelopePhasing.findMany({ where: { versionId }, orderBy: { month: "asc" } })).map((p) => ({ month: p.month.toISOString().slice(0, 10), amount: new Decimal(p.amount.toString()) }));
}

/** Whether a version's phasing has a month outside the new dates, so it is re-spread. */
async function movesPhasing(tx: Tx, versionId: string | null, to: { startDate: string; endDate: string }): Promise<boolean> {
  if (versionId === null) return false;
  const months = new Set(monthsOf(to.startDate, to.endDate));
  return (await phasingOf(tx, versionId)).some((p) => !months.has(p.month));
}

async function versionStatus(tx: Tx, id: string | null) {
  return id === null ? null : ((await tx.envelopeVersion.findUnique({ where: { id }, select: { status: true } }))?.status ?? null);
}

const view = (p: Plan): DateChangePreview => ({
  lines: p.lines.map((l) => ({ envelopeId: l.envelopeId, name: l.name, from: l.from, to: l.to, rephased: l.rephased })),
  childrenOutside: p.outside.length,
  needsApproval: p.needsApproval,
  movedShare: p.movedShare.toDecimalPlaces(4).toFixed(4),
});

/** POST /envelopes/:id/dates/preview: what the change moves, and whether it needs approval. Writes nothing. */
export async function previewDates(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown): Promise<DateChangePreview> {
  const envelopeId = parseId(rawId);
  const input = parseInput(ChangeDatesInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const plan = await planDates(tx, auth, envelopeId, input);
    for (const l of plan.lines) l.rephased = await movesPhasing(tx, l.env.draftVersionId ?? l.env.currentVersionId, l.to);
    return view(plan);
  });
}

/** POST /envelopes/:id/dates. */
export async function changeDates(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(ChangeDatesInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => changeDatesIn(tx, auth, workspaceId, envelopeId, input), { timeoutMs: 60_000 });
}

export async function changeDatesIn(tx: Tx, auth: AuthContext, workspaceId: string, envelopeId: string, input: ChangeDatesInput) {
  const plan = await planDates(tx, auth, envelopeId, input);
  if (plan.outside.length > 0 && !input.trimChildren) {
    throw new DomainError("CONFLICT", `${plan.outside.length} budget${plan.outside.length === 1 ? "" : "s"} under this one fall outside the new dates`, { children: view(plan).lines.slice(1) });
  }
  const note = (l: Line) => `Dates ${l.from.startDate} – ${l.from.endDate} → ${l.to.startDate} – ${l.to.endDate}${input.rationale ? `: ${input.rationale}` : ""}`;
  const versionIds: string[] = [];
  let amountReporting = new Decimal(0);
  for (const l of plan.lines) {
    const draftStatus = await versionStatus(tx, l.env.draftVersionId);
    if (draftStatus === "PENDING") throw new DomainError("CONFLICT", `${l.name} is waiting for approval; withdraw that request first`, { envelopeId: l.envelopeId });
    const target = { ...l.env, startDate: l.to.startDate, endDate: l.to.endDate };
    if (plan.needsApproval && l.env.currentVersionId !== null) {
      // A new version holds the same approved amount in the new dates; an unsent draft would be lost.
      if (l.env.draftVersionId !== null) throw new DomainError("CONFLICT", `${l.name} has an unsent draft; send or discard it first`, { envelopeId: l.envelopeId });
      const current = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: l.env.currentVersionId } });
      const amount = new Decimal(current.amount.toString());
      l.rephased = await movesPhasing(tx, current.id, l.to);
      const phasing = respread(await phasingOf(tx, current.id), amount, l.to);
      const v = await writeDraftVersion(tx, auth, target, { amount, phasing, rationale: note(l), attachments: [] });
      versionIds.push(v.id);
      amountReporting = amountReporting.plus(new Decimal(current.amountReporting.toString()));
    } else if (l.env.draftVersionId !== null) {
      // A budget never approved: its draft's phasing moves into the new dates in a new draft.
      const draft = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: l.env.draftVersionId } });
      if (await movesPhasing(tx, draft.id, l.to)) {
        const amount = new Decimal(draft.amount.toString());
        await writeDraftVersion(tx, auth, target, { amount, phasing: respread(await phasingOf(tx, draft.id), amount, l.to), rationale: note(l), attachments: [] });
        l.rephased = true;
      }
    }
  }
  const dates = plan.lines.map((l) => ({ envelopeId: l.envelopeId, startDate: l.to.startDate, endDate: l.to.endDate }));
  const before = plan.lines.map((l) => ({ envelopeId: l.envelopeId, ...l.from }));

  if (!plan.needsApproval) {
    await applyDates(tx, dates);
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "envelope.dates_changed", entityType: "envelope", entityId: envelopeId, before: { dates: before }, after: { dates }, ...(input.rationale ? { reason: input.rationale } : {}), requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "dates", envelopeId, envelopeIds: dates.map((d) => d.envelopeId), dates } });
    return { envelopeId, applied: true, requestId: null, autoApproved: false, lines: view(plan).lines };
  }

  // W3-5: each line's parent and dates as planned, so the approval can tell it was moved or re-dated meanwhile.
  const requested: BulkDatesLine[] = plan.lines.map((l) => ({ envelopeId: l.envelopeId, startDate: l.to.startDate, endDate: l.to.endDate, parentId: l.env.parentId, from: l.from }));
  const routed = await routeStructural(tx, auth, {
    kind: "dates",
    workspaceId,
    versionIds,
    archiveIds: [],
    createdIds: [],
    // Every budget the change moves waits (W3-5), with or without a new version: the hold refuses a
    // move, a re-date or an end until the request is decided, and the decision gives the status back.
    holdIds: plan.lines.map((l) => l.envelopeId),
    amountReporting: amountReporting.toDecimalPlaces(2),
    deltaAbs: amountReporting.mul(plan.movedShare).toDecimalPlaces(2),
    deltaPct: plan.movedShare,
    rationale: input.rationale || `Change the dates of ${plan.lines[0]?.name ?? "a budget"} to ${input.startDate} – ${input.endDate}`,
    payload: { dates: requested },
  });
  await audit(tx, {
    workspaceId,
    actorId: auth.user.id,
    actorType: auth.ctx.actorType,
    action: routed.autoApproved ? "envelope.dates_changed" : "envelope.dates_requested",
    entityType: "envelope",
    entityId: envelopeId,
    before: { dates: before },
    after: { dates, versionIds, ...routed },
    ...(input.rationale ? { reason: input.rationale } : {}),
    requestId: auth.ctx.requestId,
  });
  await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "dates", envelopeId, envelopeIds: dates.map((d) => d.envelopeId), bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
  return { envelopeId, applied: routed.autoApproved, requestId: routed.requestId, autoApproved: routed.autoApproved, lines: view(plan).lines };
}
