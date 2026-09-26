import { DomainError, SubmitVersionInput, newId } from "@budget/domain";
import { lockEnvelope, withTenant, type Tx } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { approveVersion } from "../../approvals/commands/approve-version.js";
import { computeDiff, summarizeDiff } from "../../approvals/diff.js";
import { addHours, recordRequestChange, type PolicySnapshot } from "../../approvals/engine.js";
import { matchPolicy } from "../../approvals/policy-matcher.js";

/**
 * POST /envelopes/:id/submit (spec §7.2). Matches the first policy by priority, freezes it on the
 * request (a request keeps its policy version), or auto-approves when the chain is empty.
 */
export async function submitVersion(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(SubmitVersionInput, raw);
  return withTenant(prisma, auth.ctx, (tx) => submitVersionIn(tx, auth, envelopeId, input));
}

/** The submit inside a caller's transaction (add-child submits the child's first draft in the same one). */
export async function submitVersionIn(tx: Tx, auth: AuthContext, envelopeId: string, input: SubmitVersionInput) {
  const env = await lockEnvelope(tx, envelopeId);
  if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
  if (env.status === "LOCKED") throw new DomainError("LOCKED", "Period is closed; restate via closure");
  assertInScope(auth, "envelope.submit", await envelopeScopeTarget(tx, envelopeId));
  if (env.draftVersionId !== input.versionId) {
    throw new DomainError("CONFLICT", "Only the open draft can be submitted", { currentVersionId: env.draftVersionId ?? env.currentVersionId });
  }
  const v = await tx.envelopeVersion.findUniqueOrThrow({ where: { id: input.versionId } });
  if (v.status !== "DRAFT") throw new DomainError("CONFLICT", `Version is ${v.status}`, { currentVersionId: v.id });

  const versionIds = (await tx.envelopeVersion.findMany({ where: { envelopeId }, select: { id: true } })).map((x) => x.id);
  const open = await tx.approvalRequest.findMany({
    where: { entityType: "envelope_version", entityId: { in: versionIds }, status: { in: ["PENDING", "ESCALATED", "CHANGES_REQUESTED"] } },
    select: { id: true, status: true },
  });
  if (open.some((r) => r.status !== "CHANGES_REQUESTED")) throw new DomainError("CONFLICT", "An approval request is already open for this envelope");

  // Unresolved blocking threads on the envelope block submission (§8.6).
  const blocking = await tx.thread.count({ where: { anchorType: "envelope", anchorId: envelopeId, status: "open", isBlocking: true } });
  if (blocking > 0) throw new DomainError("CONFLICT", "Resolve blocking threads before submitting", { blockingThreads: blocking });

  // Resubmitting after "request changes" closes the returned request; it stays in history.
  const superseded = open.map((r) => r.id);
  if (superseded.length) {
    await tx.approvalRequest.updateMany({ where: { id: { in: superseded } }, data: { status: "WITHDRAWN", resolvedAt: new Date() } });
  }

  const diff = await computeDiff(tx, v.id);
  const policy = await matchPolicy(tx, env.workspaceId, diff.facts);
  if (policy === null) throw new DomainError("POLICY_NOT_FOUND", "No approval policy matched");

  if (policy.chain.length === 0) {
    await approveVersion(tx, auth.ctx, v.id, null, `auto-approved by policy ${policy.name} v${policy.version}`);
    return { autoApproved: true as const, requestId: null, versionId: v.id, policy: { id: policy.id, name: policy.name, version: policy.version } };
  }

  const snapshot: PolicySnapshot = {
    conditions: policy.conditionsParsed,
    chain: policy.chain,
    blockSelfApproval: policy.blockSelfApproval,
    allowExternalEvidence: policy.allowExternalEvidence,
    policyName: policy.name,
  };
  const request = await tx.approvalRequest.create({
    data: {
      id: newId(),
      workspaceId: env.workspaceId,
      entityType: "envelope_version",
      entityId: v.id,
      policyId: policy.id,
      policyVersion: policy.version,
      policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
      currentStep: 0,
      status: "PENDING",
      summary: summarizeDiff(diff, v.rationale),
      requestedBy: auth.user.id,
      dueAt: addHours(new Date(), policy.chain[0]?.timeoutHours ?? 48),
    },
  });
  await tx.envelopeVersion.update({ where: { id: v.id }, data: { status: "PENDING" } });
  await tx.envelope.update({ where: { id: envelopeId }, data: { status: "PENDING", rowVersion: { increment: 1 } } });
  await recordRequestChange(tx, auth.ctx, request, "approval.requested", {
    versionId: v.id,
    envelopeId,
    policy: policy.name,
    policyVersion: policy.version,
    status: "PENDING",
    step: 0,
    supersededRequests: superseded,
  });
  return { autoApproved: false as const, requestId: request.id, versionId: v.id, policy: { id: policy.id, name: policy.name, version: policy.version } };
}
