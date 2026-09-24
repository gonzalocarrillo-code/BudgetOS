import { DomainError, MergeEnvelopesInput, MoveEnvelopeInput, SplitEnvelopeInput, newId } from "@budget/domain";
import {
  audit,
  auditMany,
  bumpDataVersion,
  insertBulkChange,
  lockEnvelope,
  lockApprovalRequest,
  lockEnvelopes,
  lockParentCap,
  outbox,
  withTenant,
  type LockedEnvelopeRow,
  type Tx,
} from "@budget/db";
import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { computeDiff } from "../../approvals/diff.js";
import { addHours, closeRequest, finalizeBulk, openBlockingThread, recordRequestChange, type PolicySnapshot } from "../../approvals/engine.js";
import { matchPolicy } from "../../approvals/policy-matcher.js";
import { rephase } from "../bulk/allocate.js";
import { insertEnvelopeRow } from "./create-envelope.js";
import { assertBasedOnHead, assertDraftNotPending, lockForWrite, recordEnvelopeChange, resolveFx, writeDraftVersion } from "./version-writer.js";

/**
 * Move / split / merge (spec §7.5, plan §4.3): lineage in envelope_lineage, caps re-validated,
 * `envelope.move` permission. Split and merge never edit an approved amount: each source gets a
 * zero-amount version and is archived once the change is approved, so its history and as_of reads
 * stay intact and the new siblings fit the parent's cap.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------------------------

export async function moveEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(MoveEnvelopeInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.move");
    if (input.rowVersion !== env.rowVersion) {
      throw new DomainError("CONFLICT", "Envelope changed since you loaded it", { currentRowVersion: env.rowVersion, currentVersionId: env.draftVersionId ?? env.currentVersionId });
    }
    const row = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { parentId: true, name: true } });
    if (row.parentId === input.parentId) throw new DomainError("VALIDATION", "The envelope is already under that parent");

    if (input.parentId !== null) {
      // No cycles: the new parent must not be the envelope or one of its descendants.
      for (let p: string | null = input.parentId, depth = 0; p !== null && depth < 64; depth += 1) {
        if (p === envelopeId) throw new DomainError("VALIDATION", "An envelope cannot move under itself or its own descendant");
        p = (await tx.envelope.findUnique({ where: { id: p }, select: { parentId: true } }))?.parentId ?? null;
      }
      const parent = await tx.envelope.findUnique({ where: { id: input.parentId }, select: { status: true } });
      if (parent === null) throw new DomainError("NOT_FOUND", "New parent not found");
      if (parent.status === "LOCKED") throw new DomainError("LOCKED", "New parent's period is closed");
      if (parent.status === "ARCHIVED") throw new DomainError("CONFLICT", "New parent is archived");
      assertInScope(auth, "envelope.move", await envelopeScopeTarget(tx, input.parentId));
      // Cap re-validation under the new parent's row lock (spec §7.5): its approved amount must
      // still cover its approved children plus this envelope's approved amount.
      const cap = await lockParentCap(tx, input.parentId, envelopeId);
      const mine = env.currentVersionId ? await tx.envelopeVersion.findUnique({ where: { id: env.currentVersionId }, select: { amountReporting: true } }) : null;
      if (cap && !cap.allowOverAllocation && cap.parentAmount !== null) {
        const children = new Decimal(cap.siblingsSum).plus(mine?.amountReporting.toString() ?? 0);
        if (children.gt(cap.parentAmount)) {
          throw new DomainError("CAP_EXCEEDED", "Moving here would put the parent's children above its budget", { parent: cap.parentAmount, children: children.toFixed(2) });
        }
      }
    }

    await tx.envelope.update({ where: { id: envelopeId }, data: { parentId: input.parentId, rowVersion: { increment: 1 } } });
    const lineageId = newId();
    await tx.envelopeLineage.create({
      data: { id: lineageId, workspaceId: env.workspaceId, fromEnvelopeId: envelopeId, toEnvelopeId: input.parentId ?? envelopeId, kind: "move", versionId: env.currentVersionId, actorId: auth.user.id },
    });

    // Re-route an open request if the move changes which policy it would match (spec §7.5).
    const rerouted = await rerouteOpenRequest(tx, auth, envelopeId, row.name);
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.moved",
      kind: "moved",
      before: { parentId: row.parentId },
      after: { parentId: input.parentId, lineageId, reroutedRequestId: rerouted },
      reason: input.rationale,
    });
    return { envelopeId, parentId: input.parentId, lineageId, reroutedRequestId: rerouted };
  });
}

async function rerouteOpenRequest(tx: Tx, auth: AuthContext, envelopeId: string, name: string): Promise<string | null> {
  const versionIds = (await tx.envelopeVersion.findMany({ where: { envelopeId }, select: { id: true } })).map((v) => v.id);
  const open = await tx.approvalRequest.findFirst({ where: { entityType: "envelope_version", entityId: { in: versionIds }, status: { in: ["PENDING", "ESCALATED"] } } });
  if (open === null) return null;
  const diff = await computeDiff(tx, open.entityId);
  const policy = await matchPolicy(tx, open.workspaceId, diff.facts);
  if (policy !== null && policy.id === open.policyId && policy.version === open.policyVersion) return null;
  const locked = await lockApprovalRequest(tx, open.id);
  if (locked === null) return null;
  await closeRequest(tx, locked, "CHANGES_REQUESTED");
  const comment = `[system] ${name} was moved; the change now matches ${policy ? `policy "${policy.name}" v${policy.version}` : "no policy"} instead of the one this request was routed by. Resubmit to route it again.`;
  const threadId = await openBlockingThread(tx, auth.ctx, locked, comment);
  await recordRequestChange(tx, auth.ctx, open, "approval.rerouted", { status: "CHANGES_REQUESTED", threadId, newPolicy: policy?.name ?? null });
  return open.id;
}

// ---------------------------------------------------------------------------------------------
// Split and merge: one bulk_change, one approval (or auto-approval), sources archived at the end
// ---------------------------------------------------------------------------------------------

interface Structural {
  kind: "split" | "merge";
  workspaceId: string;
  versionIds: string[];
  archiveIds: string[];
  createdIds: string[];
  amountReporting: Decimal;
  rationale: string;
}

async function routeStructural(tx: Tx, auth: AuthContext, s: Structural): Promise<{ bulkChangeId: string; requestId: string | null; autoApproved: boolean; policy: { name: string; version: number } }> {
  const bulkChangeId = newId();
  await insertBulkChange(tx, { id: bulkChangeId, workspaceId: s.workspaceId, kind: s.kind, versionIds: s.versionIds, archiveIds: s.archiveIds, createdIds: s.createdIds, createdBy: auth.user.id });
  // Structural change: the total is unchanged (parts sum to the source; the merge holds the sum).
  const policy = await matchPolicy(tx, s.workspaceId, {
    entityType: "bulk_change",
    amountAbs: s.amountReporting,
    deltaAbs: new Decimal(0),
    deltaPct: new Decimal(0),
    isOverAllocation: false,
    level: 0,
    dimensionValues: {},
    daysRemaining: 0,
  });
  if (policy === null) throw new DomainError("POLICY_NOT_FOUND", "No approval policy matched");
  if (policy.chain.length === 0) {
    await finalizeBulk(tx, auth.ctx, bulkChangeId, null, `auto-approved by policy ${policy.name} v${policy.version}`);
    return { bulkChangeId, requestId: null, autoApproved: true, policy: { name: policy.name, version: policy.version } };
  }
  const requestId = newId();
  const snapshot: PolicySnapshot = { conditions: policy.conditionsParsed, chain: policy.chain, blockSelfApproval: policy.blockSelfApproval, allowExternalEvidence: policy.allowExternalEvidence, policyName: policy.name };
  await tx.approvalRequest.create({
    data: {
      id: requestId,
      workspaceId: s.workspaceId,
      entityType: "bulk_change",
      entityId: bulkChangeId,
      policyId: policy.id,
      policyVersion: policy.version,
      policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
      summary: `${s.kind === "split" ? "Split" : "Merge"}: ${s.versionIds.length} versions, ${s.amountReporting.toFixed(2)} (reporting). ${s.rationale.slice(0, 200)}`,
      requestedBy: auth.user.id,
      dueAt: addHours(new Date(), policy.chain[0]?.timeoutHours ?? 48),
    },
  });
  await tx.envelopeVersion.updateMany({ where: { id: { in: s.versionIds } }, data: { status: "PENDING" } });
  await tx.envelope.updateMany({ where: { id: { in: [...s.archiveIds, ...s.createdIds] } }, data: { status: "PENDING" } });
  return { bulkChangeId, requestId, autoApproved: false, policy: { name: policy.name, version: policy.version } };
}

async function currentPhasing(tx: Tx, versionId: string) {
  return (await tx.envelopePhasing.findMany({ where: { versionId }, orderBy: { month: "asc" } })).map((p) => ({ month: isoDate(p.month), amount: new Decimal(p.amount.toString()) }));
}

/** POST /envelopes/:id/split (spec §7.5). */
export async function splitEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const sourceId = parseId(rawId);
  const input = parseInput(SplitEnvelopeInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const env = await lockForWrite(tx, auth, sourceId, "envelope.move");
      assertBasedOnHead(env, input.basedOnVersionId);
      await assertDraftNotPending(tx, env);
      if (env.currentVersionId === null) throw new DomainError("VALIDATION", "Only an envelope with an approved budget can be split");
      const current = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: env.currentVersionId } });
      const total = input.parts.reduce((s, p) => s.plus(p.amount), new Decimal(0));
      if (!total.equals(current.amount.toString())) {
        throw new DomainError("VALIDATION", "Parts must sum to the approved amount", { approved: current.amount.toFixed(2), parts: total.toFixed(2) });
      }
      const source = await tx.envelope.findUniqueOrThrow({ where: { id: sourceId } });
      const shape = await currentPhasing(tx, current.id);
      const partIds: string[] = [];
      const versionIds: string[] = [];
      const lineage: Prisma.EnvelopeLineageCreateManyInput[] = [];
      for (const part of input.parts) {
        const row = await insertEnvelopeRow(
          tx,
          auth,
          workspaceId,
          {
            name: part.name,
            parentId: source.parentId,
            dimensionValues: { ...(source.dimensionValues as Record<string, string>), ...part.dimensionValues },
            startDate: isoDate(source.startDate),
            endDate: isoDate(source.endDate),
            currency: source.currency,
            ownerId: source.ownerId,
            periodId: source.periodId,
          },
          "envelope.move",
        );
        const amount = new Decimal(part.amount);
        const v = await writeDraftVersion(tx, auth, row, {
          amount,
          phasing: shape.length ? rephase(shape, amount).map((p) => ({ month: p.month, amount: p.amount.toFixed(2) })) : undefined,
          rationale: input.rationale,
          attachments: [],
        });
        partIds.push(row.id);
        versionIds.push(v.id);
        lineage.push({ id: newId(), workspaceId, fromEnvelopeId: sourceId, toEnvelopeId: row.id, kind: "split", versionId: v.id, actorId: auth.user.id });
      }
      const zero = await writeDraftVersion(tx, auth, env, { amount: new Decimal(0), phasing: undefined, rationale: `Split into ${input.parts.length}: ${input.rationale}`, attachments: [] });
      await tx.envelopeLineage.createMany({ data: lineage });
      const rate = (await resolveFx(tx, source.currency, workspaceId)).rate;
      const routed = await routeStructural(tx, auth, {
        kind: "split",
        workspaceId,
        versionIds: [zero.id, ...versionIds],
        archiveIds: [sourceId],
        createdIds: partIds,
        amountReporting: total.mul(rate).toDecimalPlaces(2),
        rationale: input.rationale,
      });
      await audit(tx, {
        workspaceId,
        actorId: auth.user.id,
        actorType: auth.ctx.actorType,
        action: "envelope.split",
        entityType: "envelope",
        entityId: sourceId,
        before: { versionId: env.currentVersionId, amount: current.amount.toFixed(2) },
        after: { parts: partIds, zeroVersionId: zero.id, ...routed },
        reason: input.rationale,
        requestId: auth.ctx.requestId,
      });
      await auditMany(
        tx,
        partIds.map((id, i) => ({
          workspaceId,
          actorId: auth.user.id,
          actorType: auth.ctx.actorType,
          action: "envelope.created",
          entityType: "envelope",
          entityId: id,
          after: { splitFrom: sourceId, versionId: versionIds[i], amount: input.parts[i]?.amount, bulkChangeId: routed.bulkChangeId },
          reason: input.rationale,
          requestId: auth.ctx.requestId,
        })),
      );
      await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "split", sourceId, partIds, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
      await bumpDataVersion(tx, workspaceId);
      return { sourceId, partIds, ...routed };
    },
    { timeoutMs: 60_000 },
  );
}

/** POST /envelopes/merge (spec §7.5): the inverse of split. */
export async function mergeEnvelopes(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(MergeEnvelopesInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const ids = [...new Set(input.sourceIds)];
  if (ids.length < 2) throw new DomainError("VALIDATION", "Merge needs at least two different envelopes");
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      await lockEnvelopes(tx, ids);
      const locked: LockedEnvelopeRow[] = [];
      for (const id of ids) {
        const env = await lockForWrite(tx, auth, id, "envelope.move");
        await assertDraftNotPending(tx, env);
        if (env.currentVersionId === null) throw new DomainError("VALIDATION", "Only envelopes with an approved budget can be merged", { envelopeId: id });
        locked.push(env);
      }
      const sources = await tx.envelope.findMany({ where: { id: { in: ids } } });
      const parents = new Set(sources.map((s) => s.parentId));
      const currencies = new Set(sources.map((s) => s.currency));
      if (parents.size !== 1) throw new DomainError("VALIDATION", "Merged envelopes must share a parent");
      if (currencies.size !== 1) throw new DomainError("VALIDATION", "Merged envelopes must share a currency");
      const parentId = sources[0]?.parentId ?? null;
      const currency = sources[0]?.currency as string;
      const currents = await tx.envelopeVersion.findMany({ where: { id: { in: locked.map((e) => e.currentVersionId as string) } } });
      const total = currents.reduce((s, v) => s.plus(v.amount.toString()), new Decimal(0));
      const byMonth = new Map<string, Decimal>();
      for (const ph of await tx.envelopePhasing.findMany({ where: { versionId: { in: currents.map((c) => c.id) } } })) {
        const m = isoDate(ph.month);
        byMonth.set(m, (byMonth.get(m) ?? new Decimal(0)).plus(ph.amount.toString()));
      }
      const phasingTotal = [...byMonth.values()].reduce((s, v) => s.plus(v), new Decimal(0));
      const start = sources.map((s) => isoDate(s.startDate)).sort()[0] as string;
      const end = sources.map((s) => isoDate(s.endDate)).sort().at(-1) as string;
      const target = await insertEnvelopeRow(tx, auth, workspaceId, { name: input.name, parentId, dimensionValues: input.dimensionValues, startDate: start, endDate: end, currency, ownerId: null, periodId: null }, "envelope.move");
      const targetVersion = await writeDraftVersion(tx, auth, target, {
        amount: total,
        // Keep the combined monthly shape when every source was phased (so the months sum to the total).
        phasing: phasingTotal.equals(total) && byMonth.size ? [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount: amount.toFixed(2) })) : undefined,
        rationale: input.rationale,
        attachments: [],
      });
      const zeros: string[] = [];
      for (const env of locked) {
        const fresh = (await lockEnvelope(tx, env.id)) as LockedEnvelopeRow;
        zeros.push((await writeDraftVersion(tx, auth, fresh, { amount: new Decimal(0), phasing: undefined, rationale: `Merged into ${input.name}: ${input.rationale}`, attachments: [] })).id);
      }
      await tx.envelopeLineage.createMany({
        data: ids.map((id) => ({ id: newId(), workspaceId, fromEnvelopeId: id, toEnvelopeId: target.id, kind: "merge", versionId: targetVersion.id, actorId: auth.user.id })),
      });
      const rate = (await resolveFx(tx, currency, workspaceId)).rate;
      const routed = await routeStructural(tx, auth, {
        kind: "merge",
        workspaceId,
        versionIds: [...zeros, targetVersion.id],
        archiveIds: ids,
        createdIds: [target.id],
        amountReporting: total.mul(rate).toDecimalPlaces(2),
        rationale: input.rationale,
      });
      await auditMany(tx, [
        ...ids.map((id) => ({
          workspaceId,
          actorId: auth.user.id,
          actorType: auth.ctx.actorType,
          action: "envelope.merged",
          entityType: "envelope",
          entityId: id,
          after: { into: target.id, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId },
          reason: input.rationale,
          requestId: auth.ctx.requestId,
        })),
        {
          workspaceId,
          actorId: auth.user.id,
          actorType: auth.ctx.actorType,
          action: "envelope.created",
          entityType: "envelope",
          entityId: target.id,
          after: { mergedFrom: ids, versionId: targetVersion.id, amount: total.toFixed(2), bulkChangeId: routed.bulkChangeId },
          reason: input.rationale,
          requestId: auth.ctx.requestId,
        },
      ]);
      await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "merge", sourceIds: ids, targetId: target.id, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
      await bumpDataVersion(tx, workspaceId);
      return { sourceIds: ids, targetId: target.id, ...routed };
    },
    { timeoutMs: 60_000 },
  );
}
