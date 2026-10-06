import { DecideInput, DomainError, eligibleApprover, newId, type Role } from "@budget/domain";
import { eligibleApproverSql, lockApprovalRequest, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { DIRECT_ROLES } from "../policy-matcher.js";
import { advanceIfComplete, assertEnvelopeRequest, assertNotLocked, assertOpen, closeRequest, lockRequestEnvelopes, openBlockingThread, recordRequestChange, requestTargets, snapshotOf } from "../engine.js";
import { STALE_REASON_TEXT, StaleRequestError } from "../revalidate-dates.js";

/**
 * POST /approvals/:id/decisions (spec §9.3). Eligibility = SQL eligible_approver() (step role,
 * step group, blockSelfApproval vs the requester) AND the app check: the step role's scope covers
 * the envelope and the decider is not the version's author (spec §5.4). An admin's approval is
 * final: the request is approved, whatever steps remain (ADR-048).
 *
 * Lock order (W3-5; structure.ts has the whole order): the request, then every envelope the
 * decision may write, by id. When the approval finds the tree changed under a date change
 * (StaleRequestError), the request goes back for changes — committed, with the reason on a blocking
 * thread, one audit row and one outbox row — and the approver gets the 409 with that reason.
 */
export async function decide(prisma: PrismaClient, auth: AuthContext, rawRequestId: string, raw: unknown) {
  const requestId = parseId(rawRequestId);
  const input = parseInput(DecideInput, raw);
  const result = await withTenant(prisma, auth.ctx, async (tx) => {
    const r = await lockApprovalRequest(tx, requestId);
    if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
    assertOpen(r);
    await lockRequestEnvelopes(tx, r);
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
      const admin = auth.isOrgAdmin || auth.roles.some((role) => (DIRECT_ROLES as readonly string[]).includes(role));
      try {
        const advanced = await advanceIfComplete(tx, auth.ctx, r, snapshot, admin);
        outcome = advanced === "approved" ? "APPROVED" : advanced === "advanced" ? "PENDING" : r.status;
      } catch (error) {
        // Thrown before the approval wrote anything (revalidate-dates.ts), so the transaction is clean.
        if (!(error instanceof StaleRequestError)) throw error;
        await closeRequest(tx, r, "CHANGES_REQUESTED");
        const env = await tx.envelope.findUnique({ where: { id: error.envelopeId }, select: { name: true, displayName: true } });
        const who = env ? (env.displayName ?? env.name) : "A budget in this change";
        const comment = `[system] ${who}: ${STALE_REASON_TEXT[error.reason]}. ${error.message}.`;
        const stale = await openBlockingThread(tx, auth.ctx, r, comment);
        await recordRequestChange(tx, auth.ctx, r, "approval.request_changes", { step: r.currentStep, comment, status: "CHANGES_REQUESTED", threadId: stale, stale: error.details ?? null });
        return { stale: error };
      }
    }
    await recordRequestChange(tx, auth.ctx, r, `approval.${input.decision}`, { step: r.currentStep, comment: input.comment ?? null, status: outcome, threadId });
    return { requestId: r.id, status: outcome };
  });
  // The request went back for changes (committed above); the approver is told why.
  if ("stale" in result) throw result.stale;
  return result;
}
