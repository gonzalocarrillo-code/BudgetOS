import { DecideInput, DomainError, eligibleApprover, newId, type Role } from "@budget/domain";
import { eligibleApproverSql, lockApprovalRequest, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { advanceIfComplete, assertEnvelopeRequest, assertNotLocked, assertOpen, closeRequest, openBlockingThread, recordRequestChange, requestTargets, snapshotOf } from "../engine.js";

/**
 * POST /approvals/:id/decisions (spec §9.3). Eligibility = SQL eligible_approver() (step role,
 * step group, blockSelfApproval vs the requester) AND the app check: the step role's scope covers
 * the envelope and the decider is not the version's author (spec §5.4).
 */
export async function decide(prisma: PrismaClient, auth: AuthContext, rawRequestId: string, raw: unknown) {
  const requestId = parseId(rawRequestId);
  const input = parseInput(DecideInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const r = await lockApprovalRequest(tx, requestId);
    if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
    assertOpen(r);
    assertEnvelopeRequest(r);
    await assertNotLocked(tx, r);
    const snapshot = snapshotOf(r);
    const step = snapshot.chain[r.currentStep];
    if (step === undefined) throw new DomainError("VALIDATION", "Request is past its last step");

    const targets = await requestTargets(tx, r);
    const sqlOk = await eligibleApproverSql(tx, r.id, auth.user.id);
    // The step role's scope must cover every envelope (or the target) the request would approve.
    const appOk = targets.scopes.every((target) =>
      eligibleApprover({
        assignments: auth.assignments,
        stepRole: step.role as Role,
        target,
        userId: auth.user.id,
        authorId: targets.authorId,
        blockSelfApproval: snapshot.blockSelfApproval,
      }),
    );
    if (!sqlOk || !appOk) throw new DomainError("FORBIDDEN", "You are not an eligible approver for this step", { step: r.currentStep, role: step.role });
    const already = await tx.approvalDecision.count({ where: { requestId: r.id, stepIndex: r.currentStep, decidedBy: auth.user.id } });
    if (already) throw new DomainError("CONFLICT", "You already decided this step");

    await tx.approvalDecision.create({
      data: { id: newId(), requestId: r.id, stepIndex: r.currentStep, decidedBy: auth.user.id, decision: input.decision, comment: input.comment ?? null, channel: input.channel },
    });
    let outcome: string;
    let threadId: string | null = null;
    if (input.decision === "reject") {
      await closeRequest(tx, r, "REJECTED");
      outcome = "REJECTED";
    } else if (input.decision === "request_changes") {
      await closeRequest(tx, r, "CHANGES_REQUESTED");
      threadId = await openBlockingThread(tx, auth.ctx, r, input.comment ?? "");
      outcome = "CHANGES_REQUESTED";
    } else {
      const advanced = await advanceIfComplete(tx, auth.ctx, r, snapshot);
      outcome = advanced === "approved" ? "APPROVED" : advanced === "advanced" ? "PENDING" : r.status;
    }
    await recordRequestChange(tx, auth.ctx, r, `approval.${input.decision}`, { step: r.currentStep, comment: input.comment ?? null, status: outcome, threadId });
    return { requestId: r.id, status: outcome };
  });
}
