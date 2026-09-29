import { DomainError } from "@budget/domain";
import { audit, lastRequestAuditAt, lockApprovalRequest, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertOpen } from "../engine.js";

/** How often one request's approvers may be reminded. */
export const REMIND_EVERY_MINUTES = 60;

/**
 * Reminds the approvers of an open request's current step (S-004): the notify worker sends each a
 * new Slack direct message and an in-app notification (outbox topic `approval.reminded`). Only the
 * requester or a workspace admin may, at most once an hour per request.
 */
export async function remindApprovers(prisma: PrismaClient, auth: AuthContext, rawRequestId: string, now: Date = new Date()) {
  const requestId = parseId(rawRequestId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const r = await lockApprovalRequest(tx, requestId);
    if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
    assertOpen(r);
    const admin = auth.isOrgAdmin || auth.roles.includes("WORKSPACE_ADMIN");
    if (r.requestedBy !== auth.user.id && !admin) throw new DomainError("FORBIDDEN", "Only the requester or a workspace admin can send a reminder");
    const last = await lastRequestAuditAt(tx, r.id, "approval.reminded");
    const next = last ? new Date(last.getTime() + REMIND_EVERY_MINUTES * 60_000) : null;
    if (next && next > now) throw new DomainError("CONFLICT", `The approvers were reminded less than an hour ago; you can remind them again at ${next.toISOString().slice(11, 16)} UTC`, { nextAt: next.toISOString() });
    await audit(tx, { workspaceId: r.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "approval.reminded", entityType: "approval_request", entityId: r.id, after: { step: r.currentStep }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: r.workspaceId, topic: "approval.reminded", payload: { requestId: r.id, step: r.currentStep, by: auth.user.id } });
    return { requestId: r.id, step: r.currentStep, reminded: true as const };
  });
}
