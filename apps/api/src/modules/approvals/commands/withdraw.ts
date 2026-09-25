import { DomainError, WithdrawInput } from "@budget/domain";
import { lockApprovalRequest, withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertNotLocked, assertOpen, closeRequest, recordRequestChange } from "../engine.js";

async function withdrawLocked(tx: Tx, auth: AuthContext, requestId: string, comment: string | undefined) {
  const r = await lockApprovalRequest(tx, requestId);
  if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
  assertOpen(r);
  const admin = auth.isOrgAdmin || auth.roles.includes("WORKSPACE_ADMIN");
  if (r.requestedBy !== auth.user.id && !admin) throw new DomainError("FORBIDDEN", "Only the requester or a workspace admin can withdraw");
  await assertNotLocked(tx, r);
  await closeRequest(tx, r, "WITHDRAWN");
  await recordRequestChange(tx, auth.ctx, r, "approval.withdrawn", { comment: comment ?? null, status: "WITHDRAWN" });
  return { requestId: r.id, status: "WITHDRAWN" as const };
}

/** POST /approvals/:id/withdraw. The version becomes WITHDRAWN (kept); a new draft starts from the approved version. */
export async function withdrawRequest(prisma: PrismaClient, auth: AuthContext, rawRequestId: string, raw: unknown) {
  const requestId = parseId(rawRequestId);
  const input = parseInput(WithdrawInput, raw ?? {});
  return withTenant(prisma, auth.ctx, (tx) => withdrawLocked(tx, auth, requestId, input.comment));
}

/** POST /envelopes/:id/withdraw: withdraws the envelope's open request. */
export async function withdrawEnvelope(prisma: PrismaClient, auth: AuthContext, rawEnvelopeId: string, raw: unknown) {
  const envelopeId = parseId(rawEnvelopeId);
  const input = parseInput(WithdrawInput, raw ?? {});
  return withTenant(prisma, auth.ctx, async (tx) => {
    const versionIds = (await tx.envelopeVersion.findMany({ where: { envelopeId }, select: { id: true } })).map((v) => v.id);
    const open = await tx.approvalRequest.findFirst({ where: { entityType: "envelope_version", entityId: { in: versionIds }, status: { in: ["PENDING", "ESCALATED"] } }, select: { id: true } });
    if (open === null) throw new DomainError("NOT_FOUND", "No open approval request for this envelope");
    return withdrawLocked(tx, auth, open.id, input.comment);
  });
}
