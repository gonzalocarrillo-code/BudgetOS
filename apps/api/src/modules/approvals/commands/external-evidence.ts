import { DomainError, ExternalEvidenceInput, newId } from "@budget/domain";
import { lockApprovalRequest, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { advanceIfComplete, assertEnvelopeRequest, assertOpen, recordRequestChange, requestTargets, snapshotOf } from "../engine.js";

/**
 * POST /approvals/:id/external-evidence (spec §9.3, plan §8.2). Always recorded as a decision with
 * `channel='external_upload'`; it counts toward the step's minApprovals only when the frozen
 * policy allows external evidence.
 */
export async function recordExternalEvidence(prisma: PrismaClient, auth: AuthContext, rawRequestId: string, raw: unknown) {
  const requestId = parseId(rawRequestId);
  const input = parseInput(ExternalEvidenceInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const r = await lockApprovalRequest(tx, requestId);
    if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
    assertOpen(r);
    assertEnvelopeRequest(r);
    const targets = await requestTargets(tx, r);
    for (const t of (await envelopeScopeTargets(tx, [...new Set(targets.versions.map((v) => v.envelopeId))])).values()) assertInScope(auth, "envelope.submit", t);
    const snapshot = snapshotOf(r);
    const evidence = { gcsUri: input.gcsUri, sha256: input.sha256, approverName: input.approverName, approvedOn: input.approvedOn };
    await tx.approvalDecision.create({
      data: { id: newId(), requestId: r.id, stepIndex: r.currentStep, decidedBy: auth.user.id, decision: "external_evidence", comment: input.comment ?? null, evidence, channel: "external_upload" },
    });
    const counts = snapshot.allowExternalEvidence;
    const advanced = counts ? await advanceIfComplete(tx, auth.ctx, r, snapshot) : "waiting";
    const status = advanced === "approved" ? "APPROVED" : advanced === "advanced" ? "PENDING" : r.status;
    await recordRequestChange(tx, auth.ctx, r, "approval.external_evidence", { step: r.currentStep, counts, evidence, status });
    return { requestId: r.id, counted: counts, status };
  });
}
