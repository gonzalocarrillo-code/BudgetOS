import { ChainStep, DomainError, newId } from "@budget/domain";
import { audit, outbox, type LockedRequestRow, type TenantContext, type Tx } from "@budget/db";
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
  if (r.entityType !== "envelope_version") {
    throw new DomainError("VALIDATION", `Approvals for ${r.entityType} are not supported yet`, { entityType: r.entityType });
  }
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
    await approveVersion(tx, ctx, r.entityId, r.id, `approved via policy ${snapshot.policyName ?? r.policyId} v${r.policyVersion}`);
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
  const version = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: r.entityId }, select: { envelopeId: true } });
  const threadId = newId();
  await tx.thread.create({
    data: {
      id: threadId,
      workspaceId: r.workspaceId,
      anchorType: "envelope",
      anchorId: version.envelopeId,
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
