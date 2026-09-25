import { ChainStep, DomainError, newId, type ScopeTarget } from "@budget/domain";
import { archiveEnvelopes, audit, closeBulkVersions, loadBulkChange, outbox, type LockedRequestRow, type TenantContext, type Tx } from "@budget/db";
import { z } from "zod";
import { clock } from "../../common/clock.js";
import { envelopeScopeTargets } from "../../common/scope.guard.js";
import { approveTargetVersion } from "../targets/commands/approve-target-version.js";
import { targetScope } from "../targets/commands/target-writer.js";
import { approveVersion } from "./commands/approve-version.js";

/** The frozen policy copy on a request (spec §7.2). Escalation may insert synthetic steps. */
export const PolicySnapshot = z.object({
  conditions: z.unknown(),
  chain: z.array(ChainStep.extend({ escalatedFrom: z.number().int().optional() })),
  blockSelfApproval: z.boolean(),
  allowExternalEvidence: z.boolean(),
  policyName: z.string().optional(),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;

export const OPEN_STATUSES = ["PENDING", "ESCALATED"] as const;
const HOUR_MS = 3_600_000;
export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR_MS);

export function snapshotOf(r: LockedRequestRow): PolicySnapshot {
  const parsed = PolicySnapshot.safeParse(r.policySnapshot);
  if (!parsed.success) throw new DomainError("VALIDATION", "Request has an unreadable policy snapshot", { requestId: r.id });
  return parsed.data;
}

export function assertOpen(r: LockedRequestRow): void {
  if (!(OPEN_STATUSES as readonly string[]).includes(r.status)) throw new DomainError("CONFLICT", `Request is ${r.status}`, { status: r.status });
}

export const SUPPORTED_ENTITY_TYPES = ["envelope_version", "bulk_change", "target_version"] as const;

export function assertEnvelopeRequest(r: LockedRequestRow): void {
  if (!(SUPPORTED_ENTITY_TYPES as readonly string[]).includes(r.entityType)) {
    throw new DomainError("VALIDATION", `Approvals for ${r.entityType} are not supported yet`, { entityType: r.entityType });
  }
}

export interface RequestTargets {
  /** Envelope versions the request would approve: one for an envelope version, all rows of a bulk change, none for a target. */
  versions: Array<{ id: string; envelopeId: string }>;
  /** Who authored the change (separation of duties). */
  authorId: string;
  /** Dimension scopes an approver must cover: one per envelope, or the target's scope. */
  scopes: ScopeTarget[];
}

/** The versions, author and scopes behind a request (envelope_version, bulk_change or target_version). */
export async function requestTargets(tx: Tx, r: { entityType: string; entityId: string }): Promise<RequestTargets> {
  const scopesOf = async (versions: Array<{ envelopeId: string }>) => [...(await envelopeScopeTargets(tx, [...new Set(versions.map((v) => v.envelopeId))])).values()];
  if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
    const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { id: true, envelopeId: true } });
    return { versions, authorId: bulk.createdBy, scopes: await scopesOf(versions) };
  }
  if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId }, include: { target: true } });
    if (tv === null) throw new DomainError("NOT_FOUND", "Target version not found");
    return { versions: [], authorId: tv.createdBy, scopes: [await targetScope(tx, tv.target)] };
  }
  const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, select: { id: true, envelopeId: true, createdBy: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Version not found");
  return { versions: [{ id: v.id, envelopeId: v.envelopeId }], authorId: v.createdBy, scopes: await scopesOf([v]) };
}

/** A closed period freezes its envelopes' requests too (spec §15): no decision or withdrawal until it is restated. */
export async function assertNotLocked(tx: Tx, r: { entityType: string; entityId: string }): Promise<void> {
  if (r.entityType === "target_version") return;
  const { versions } = await requestTargets(tx, r);
  const locked = await tx.envelope.count({ where: { id: { in: [...new Set(versions.map((v) => v.envelopeId))] }, status: "LOCKED" } });
  if (locked > 0) throw new DomainError("LOCKED", "Period is closed; restate via closure", { lockedEnvelopes: locked });
}

/**
 * Approves every version of a bulk change (plan §9.3; split / merge per spec §7.5). Sources being
 * archived go first — their version is the zero amount — so the new siblings fit the parent's cap;
 * the rest go parents first. Then the sources are archived.
 */
export async function finalizeBulk(tx: Tx, ctx: TenantContext, bulkChangeId: string, requestId: string | null, reason: string): Promise<void> {
  const bulk = await loadBulkChange(tx, bulkChangeId);
  if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
  const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { id: true, envelopeId: true } });
  const archive = new Set(bulk.archiveIds);
  const d = await depths(tx, versions.map((v) => v.envelopeId));
  const rank = (v: { envelopeId: string }) => (archive.has(v.envelopeId) ? -1 : (d.get(v.envelopeId) ?? 0));
  for (const v of versions.slice().sort((a, b) => rank(a) - rank(b))) {
    await approveVersion(tx, ctx, v.id, requestId, `${reason} (${bulk.kind} ${bulkChangeId})`);
  }
  await archiveEnvelopes(tx, bulk.archiveIds);
}

/** Envelope depth (0 = root) so bulk approvals run parents first and child caps see the parent's new amount. */
async function depths(tx: Tx, envelopeIds: string[]): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ id: string; d: number }>>`
    WITH RECURSIVE up AS (SELECT id AS start, parent_id, 0 AS d FROM envelope WHERE id = ANY(${envelopeIds}::uuid[])
      UNION ALL SELECT up.start, e.parent_id, up.d + 1 FROM envelope e JOIN up ON e.id = up.parent_id)
    SELECT start::text AS id, max(d)::int AS d FROM up GROUP BY start`;
  return new Map(rows.map((x) => [x.id, x.d]));
}

/** Approvals that count toward the current step: approves, plus external evidence when the policy allows it. */
export async function countedApprovals(tx: Tx, r: LockedRequestRow, snapshot: PolicySnapshot): Promise<number> {
  const decisions = snapshot.allowExternalEvidence ? ["approve", "external_evidence"] : ["approve"];
  return tx.approvalDecision.count({ where: { requestId: r.id, stepIndex: r.currentStep, decision: { in: decisions } } });
}

/** After an approving decision: advance when the step has enough approvals; approve the version after the last step. */
export async function advanceIfComplete(tx: Tx, ctx: TenantContext, r: LockedRequestRow, snapshot: PolicySnapshot): Promise<"advanced" | "approved" | "waiting"> {
  const step = snapshot.chain[r.currentStep];
  if (step === undefined) throw new DomainError("VALIDATION", "Request is past its last step", { requestId: r.id });
  if ((await countedApprovals(tx, r, snapshot)) < step.minApprovals) return "waiting";
  const next = r.currentStep + 1;
  if (next >= snapshot.chain.length) {
    const reason = `approved via policy ${snapshot.policyName ?? r.policyId} v${r.policyVersion}`;
    if (r.entityType === "bulk_change") {
      await finalizeBulk(tx, ctx, r.entityId, r.id, reason);
    } else if (r.entityType === "target_version") {
      await approveTargetVersion(tx, ctx, r.entityId, r.id, reason);
    } else {
      await approveVersion(tx, ctx, r.entityId, r.id, reason);
    }
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: "APPROVED", resolvedAt: clock.now() } });
    return "approved";
  }
  const nextStep = snapshot.chain[next];
  await tx.approvalRequest.update({ where: { id: r.id }, data: { currentStep: next, status: "PENDING", dueAt: addHours(new Date(), nextStep?.timeoutHours ?? 48) } });
  return "advanced";
}

/**
 * Ends the request without approval (reject / withdraw) or returns it for changes. The version
 * leaves PENDING: REJECTED or WITHDRAWN drafts are closed for good (the envelope's draft pointer is
 * cleared so a new draft never overwrites them); CHANGES_REQUESTED reopens the same draft for edits.
 */
export async function closeRequest(tx: Tx, r: LockedRequestRow, outcome: "REJECTED" | "WITHDRAWN" | "CHANGES_REQUESTED"): Promise<void> {
  if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
    await closeBulkVersions(tx, bulk.versionIds, outcome);
    // New split / merge envelopes that will never be approved.
    if (outcome !== "CHANGES_REQUESTED") await archiveEnvelopes(tx, bulk.createdIds);
    await tx.approvalRequest.update({ where: { id: r.id }, data: outcome === "CHANGES_REQUESTED" ? { status: outcome } : { status: outcome, resolvedAt: new Date() } });
    return;
  }
  if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId } });
    if (tv === null) throw new DomainError("NOT_FOUND", "Target version not found");
    if (outcome === "CHANGES_REQUESTED") {
      await tx.targetVersion.update({ where: { id: tv.id }, data: { status: "DRAFT" } });
      await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome } });
      return;
    }
    await tx.targetVersion.update({ where: { id: tv.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN" } });
    await tx.target.update({ where: { id: tv.targetId }, data: { draftVersionId: null } });
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome, resolvedAt: new Date() } });
    return;
  }
  const version = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, include: { envelope: true } });
  if (version === null) throw new DomainError("NOT_FOUND", "Version not found");
  const env = version.envelope;
  const restingStatus = env.currentVersionId ? "APPROVED" : "DRAFT";
  if (outcome === "CHANGES_REQUESTED") {
    await tx.envelopeVersion.update({ where: { id: version.id }, data: { status: "DRAFT" } });
    await tx.envelope.update({ where: { id: env.id }, data: { status: restingStatus, rowVersion: { increment: 1 } } });
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: "CHANGES_REQUESTED" } });
    return;
  }
  await tx.envelopeVersion.update({ where: { id: version.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN" } });
  await tx.envelope.update({ where: { id: env.id }, data: { status: restingStatus, draftVersionId: null, rowVersion: { increment: 1 } } });
  await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome, resolvedAt: new Date() } });
}

/** §8.6 integration: "request changes" opens a blocking thread on the envelope; submit is blocked until it is resolved. */
export async function openBlockingThread(tx: Tx, ctx: TenantContext, r: LockedRequestRow, comment: string): Promise<string> {
  // A bulk change spans many envelopes: the thread sits on the request itself.
  const anchor =
    r.entityType === "bulk_change"
      ? { anchorType: "approval_request", anchorId: r.id }
      : r.entityType === "target_version"
        ? { anchorType: "target", anchorId: (await tx.targetVersion.findUniqueOrThrow({ where: { id: r.entityId }, select: { targetId: true } })).targetId }
        : { anchorType: "envelope", anchorId: (await tx.envelopeVersion.findUniqueOrThrow({ where: { id: r.entityId }, select: { envelopeId: true } })).envelopeId };
  const threadId = newId();
  await tx.thread.create({
    data: {
      id: threadId,
      workspaceId: r.workspaceId,
      ...anchor,
      anchorMeta: { approvalRequestId: r.id },
      title: "Changes requested",
      isBlocking: true,
      createdBy: ctx.userId ?? r.requestedBy,
      comments: { create: { id: newId(), authorId: ctx.userId ?? r.requestedBy, bodyMd: comment } },
    },
  });
  return threadId;
}

/** One audit_event + one outbox row for a request-level change. */
export async function recordRequestChange(tx: Tx, ctx: TenantContext, r: { id: string; workspaceId: string }, action: string, after: Record<string, unknown>): Promise<void> {
  await audit(tx, {
    workspaceId: r.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.actorType,
    action,
    entityType: "approval_request",
    entityId: r.id,
    after,
    requestId: ctx.requestId,
  });
  await outbox(tx, { workspaceId: r.workspaceId, topic: "approval.changed", payload: { requestId: r.id, action, ...after } });
}
