import { DomainError, EndEnvelopeInput, ReintroduceInput, newId } from "@budget/domain";
import { audit, auditMany, bumpDataVersion, outbox, recomputeNames, withTenant, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { Envelope, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { insertEnvelopeRow } from "./create-envelope.js";
import { routeStructural } from "./structure.js";
import { assertBasedOnHead, assertDraftNotPending, lockForWrite, resolveFx, writeDraftVersion } from "./version-writer.js";

/**
 * Ending a budget and reintroducing it (H-011, H-012; docs/BUDGET_HISTORY_PLAN.md §2.8, ADR-053).
 *
 * End: a new version with the final amount, routed through the approval policy as one bulk change
 * (like split). On approval the end date and `ended_at` apply; from then on the budget is read-only
 * but keeps its versions, threads and spend. Status stays APPROVED, so the planner, roll-ups and
 * pacing read it as before.
 *
 * Reintroduce: a successor under the same parent, with the same granularities, currency and owner,
 * new dates and amount, and lineage `continues` from the ended budget. Alone, or inside End's request.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function nonNegative(amount: string, field: string): Decimal {
  const d = new Decimal(amount);
  if (d.isNegative()) throw new DomainError("VALIDATION", `${field} cannot be negative`, { [field]: amount });
  return d;
}

interface SuccessorSpec {
  name?: string | undefined;
  startDate: string;
  endDate: string;
  amount: string;
}

/** The successor row, its first draft and the `continues` lineage; routed by the caller. */
async function createSuccessor(tx: Tx, auth: AuthContext, workspaceId: string, source: Envelope, spec: SuccessorSpec, after: string, rationale: string) {
  if (spec.startDate > spec.endDate) throw new DomainError("VALIDATION", "The new budget must start before it ends", { startDate: spec.startDate, endDate: spec.endDate });
  if (spec.startDate <= after) throw new DomainError("VALIDATION", `The new budget must start after ${after}, when the old one ends`, { startDate: spec.startDate, endsOn: after });
  if (source.parentId !== null) {
    const parent = await tx.envelope.findUnique({ where: { id: source.parentId }, select: { endedAt: true, name: true } });
    if (parent?.endedAt) throw new DomainError("CONFLICT", `${parent.name} has ended too; reintroduce it first`, { parentId: source.parentId });
  }
  const amount = nonNegative(spec.amount, "amount");
  const row = await insertEnvelopeRow(
    tx,
    auth,
    workspaceId,
    {
      name: spec.name ?? source.name,
      parentId: source.parentId,
      dimensionValues: source.dimensionValues as Record<string, string>,
      startDate: spec.startDate,
      endDate: spec.endDate,
      currency: source.currency,
      ownerId: source.ownerId,
      periodId: null,
    },
    "envelope.create",
  );
  const version = await writeDraftVersion(tx, auth, row, { amount, phasing: undefined, rationale: rationale || `Continues ${source.name}`, attachments: [] });
  await tx.envelopeLineage.create({
    data: { id: newId(), workspaceId, fromEnvelopeId: source.id, toEnvelopeId: row.id, kind: "continues", versionId: version.id, actorId: auth.user.id },
  });
  await recomputeNames(tx, workspaceId, [row.id]);
  return { id: row.id, versionId: version.id, amount };
}

/** POST /envelopes/:id/end. */
export async function endEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(EndEnvelopeInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => endIn(tx, auth, workspaceId, envelopeId, input), { timeoutMs: 60_000 });
}

export async function endIn(tx: Tx, auth: AuthContext, workspaceId: string, envelopeId: string, input: EndEnvelopeInput) {
  const env = await lockForWrite(tx, auth, envelopeId, "envelope.move");
  assertBasedOnHead(env, input.basedOnVersionId);
  await assertDraftNotPending(tx, env);
  if (env.currentVersionId === null) throw new DomainError("VALIDATION", "Only a budget with an approved amount can be ended");
  if (input.endDate < env.startDate || input.endDate > env.endDate) {
    throw new DomainError("VALIDATION", `The end date must fall between ${env.startDate} and ${env.endDate}`, { startDate: env.startDate, endDate: env.endDate });
  }
  // A parent with running children cannot end alone (decision E6): its budgets end first.
  const liveChildren = await tx.envelope.count({ where: { parentId: envelopeId, status: { not: "ARCHIVED" }, endedAt: null } });
  if (liveChildren > 0) throw new DomainError("CONFLICT", "End the budgets under this one first", { liveChildren });

  const source = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  const current = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: env.currentVersionId } });
  const finalAmount = nonNegative(input.finalAmount, "finalAmount");
  const endVersion = await writeDraftVersion(tx, auth, env, {
    amount: finalAmount,
    phasing: undefined,
    rationale: input.rationale ? `Ends on ${input.endDate}: ${input.rationale}` : `Ends on ${input.endDate}`,
    attachments: [],
  });
  const successor = input.successor ? await createSuccessor(tx, auth, workspaceId, source, input.successor, input.endDate, input.rationale) : null;

  const rate = (await resolveFx(tx, source.currency, workspaceId)).rate;
  const before = new Decimal(current.amount.toString());
  const delta = finalAmount.minus(before).plus(successor?.amount ?? 0);
  const routed = await routeStructural(tx, auth, {
    kind: "end",
    workspaceId,
    versionIds: [endVersion.id, ...(successor ? [successor.versionId] : [])],
    archiveIds: [],
    createdIds: successor ? [successor.id] : [],
    holdIds: [envelopeId],
    amountReporting: finalAmount.plus(successor?.amount ?? 0).mul(rate).toDecimalPlaces(2),
    deltaAbs: delta.abs().mul(rate).toDecimalPlaces(2),
    deltaPct: before.isZero() ? new Decimal(1) : delta.div(before),
    rationale: input.rationale || `End ${source.name} on ${input.endDate}`,
    payload: { end: { envelopeId, endDate: input.endDate, reason: input.rationale } },
  });
  await auditMany(tx, [
    {
      workspaceId,
      actorId: auth.user.id,
      actorType: auth.ctx.actorType,
      action: routed.autoApproved ? "envelope.ended" : "envelope.end_requested",
      entityType: "envelope",
      entityId: envelopeId,
      before: { versionId: current.id, amount: current.amount.toFixed(2), endDate: isoDate(source.endDate) },
      after: { versionId: endVersion.id, finalAmount: finalAmount.toFixed(2), endDate: input.endDate, successorId: successor?.id ?? null, ...routed },
      reason: input.rationale,
      requestId: auth.ctx.requestId,
    },
    ...(successor
      ? [
          {
            workspaceId,
            actorId: auth.user.id,
            actorType: auth.ctx.actorType,
            action: "envelope.created",
            entityType: "envelope",
            entityId: successor.id,
            after: { continues: envelopeId, versionId: successor.versionId, amount: successor.amount.toFixed(2), bulkChangeId: routed.bulkChangeId },
            reason: input.rationale,
            requestId: auth.ctx.requestId,
          },
        ]
      : []),
  ]);
  await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "end", envelopeId, successorId: successor?.id ?? null, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
  await bumpDataVersion(tx, workspaceId);
  return { envelopeId, endVersionId: endVersion.id, successorId: successor?.id ?? null, ended: routed.autoApproved, ...routed };
}

/** POST /envelopes/:id/reintroduce: a successor for a budget that has already ended. */
export async function reintroduceEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(ReintroduceInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => reintroduceIn(tx, auth, workspaceId, envelopeId, input), { timeoutMs: 60_000 });
}

export async function reintroduceIn(tx: Tx, auth: AuthContext, workspaceId: string, envelopeId: string, input: ReintroduceInput) {
  const source = await tx.envelope.findUnique({ where: { id: envelopeId } });
  if (source === null) throw new DomainError("NOT_FOUND", "Envelope not found");
  assertInScope(auth, "envelope.create", await envelopeScopeTarget(tx, envelopeId));
  if (source.endedAt === null) throw new DomainError("CONFLICT", "Only an ended budget can be reintroduced. End it first, and add the new budget there.");
  const successor = await createSuccessor(tx, auth, workspaceId, source, input, isoDate(source.endDate), input.rationale);
  const rate = (await resolveFx(tx, source.currency, workspaceId)).rate;
  const amountReporting = successor.amount.mul(rate).toDecimalPlaces(2);
  const routed = await routeStructural(tx, auth, {
    kind: "reintroduce",
    workspaceId,
    versionIds: [successor.versionId],
    archiveIds: [],
    createdIds: [successor.id],
    amountReporting,
    deltaAbs: amountReporting,
    deltaPct: new Decimal(1),
    rationale: input.rationale || `Reintroduce ${source.name}`,
  });
  await audit(tx, {
    workspaceId,
    actorId: auth.user.id,
    actorType: auth.ctx.actorType,
    action: "envelope.created",
    entityType: "envelope",
    entityId: successor.id,
    after: { continues: envelopeId, versionId: successor.versionId, amount: successor.amount.toFixed(2), ...routed },
    reason: input.rationale,
    requestId: auth.ctx.requestId,
  });
  await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "reintroduce", envelopeId, successorId: successor.id, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
  await bumpDataVersion(tx, workspaceId);
  return { envelopeId, successorId: successor.id, ...routed };
}
