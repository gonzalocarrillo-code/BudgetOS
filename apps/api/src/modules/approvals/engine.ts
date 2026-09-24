import { ChainStep, DomainError, newId } from "@budget/domain";
import { audit, closeBulkVersions, outbox, type LockedRequestRow, type TenantContext, type Tx } from "@budget/db";
import { z } from "zod";
import { clock } from "../../common/clock.js";
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

export function assertEnvelopeRequest(r: LockedRequestRow): void {
  if (r.entityType !== "envelope_version" && r.entityType !== "bulk_change") {
    throw new DomainError("VALIDATION", `Approvals for ${r.entityType} are not supported yet`, { entityType: r.entityType });
  }
}

export interface RequestTargets {
  /** Versions the request would approve: one for an envelope version, all rows of a bulk change. */
  versions: Array<{ id: string; envelopeId: string }>;
  /** Who authored the change (separation of duties). */
  authorId: string;
}

/** The versions and author behind a request (envelope_version or bulk_change). */
export async function requestTargets(tx: Tx, r: { entityType: string; entityId: string }): Promise<RequestTargets> {
  if (r.entityType === "bulk_change") {
    const [bulk] = await tx.$queryRaw<Array<{ ids: string[]; createdBy: string }>>`
      SELECT version_ids::text[] AS ids, created_by::text AS "createdBy" FROM bulk_change WHERE id = ${r.entityId}::uuid`;
    if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
    const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.ids } }, select: { id: true, envelopeId: true } });
    return { versions, authorId: bulk.createdBy };
  }
  const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, select: { id: true, envelopeId: true, createdBy: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Version not found");
  return { versions: [{ id: v.id, envelopeId: v.envelopeId }], authorId: v.createdBy };
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
      const { versions } = await requestTargets(tx, r);
      const d = await depths(tx, versions.map((v) => v.envelopeId));
      for (const v of versions.slice().sort((a, b) => (d.get(a.envelopeId) ?? 0) - (d.get(b.envelopeId) ?? 0))) {
        await approveVersion(tx, ctx, v.id, r.id, `${reason} (bulk ${r.entityId})`);
      }
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
    const { versions } = await requestTargets(tx, r);
    await closeBulkVersions(tx, versions.map((v) => v.id), outcome);
    await tx.approvalRequest.update({ where: { id: r.id }, data: outcome === "CHANGES_REQUESTED" ? { status: outcome } : { status: outcome, resolvedAt: new Date() } });
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
