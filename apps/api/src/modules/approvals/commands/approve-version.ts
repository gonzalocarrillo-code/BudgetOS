import { DomainError } from "@budget/domain";
import { audit, bumpDataVersion, lockParentCap, outbox, type TenantContext, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import { clock } from "../../../common/clock.js";

/** Postgres check_parent_cap() raises 'CAP_EXCEEDED: …' (check_violation); surface it as the domain error. */
function asCapError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("CAP_EXCEEDED") ? new DomainError("CAP_EXCEEDED", "Children exceed parent budget", { source: "db_trigger" }) : error;
}

/**
 * Approve a version (spec §7.3): called on the last approval step or by auto-approve. The service
 * checks the parent cap under a parent row lock; the DB trigger is the backstop. The previously
 * approved version is superseded, never updated.
 */
export async function approveVersion(tx: Tx, ctx: TenantContext, versionId: string, requestId: string | null, reason: string): Promise<void> {
  const v = await tx.envelopeVersion.findUnique({ where: { id: versionId }, include: { envelope: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Version not found");
  const env = v.envelope;
  if (env.parentId) {
    const cap = await lockParentCap(tx, env.parentId, env.id);
    if (cap && !cap.allowOverAllocation && cap.parentAmount !== null) {
      const total = new Decimal(cap.siblingsSum).plus(v.amountReporting.toString());
      if (total.gt(cap.parentAmount)) {
        throw new DomainError("CAP_EXCEEDED", "Children exceed parent budget", { parent: cap.parentAmount, children: total.toFixed(2) });
      }
    }
  }
  const now = clock.now();
  try {
    if (env.currentVersionId) {
      await tx.envelopeVersion.update({ where: { id: env.currentVersionId }, data: { status: "SUPERSEDED", supersededAt: now } });
    }
    await tx.envelopeVersion.update({ where: { id: v.id }, data: { status: "APPROVED", approvedAt: now } });
  } catch (error) {
    throw asCapError(error);
  }
  await tx.envelope.update({ where: { id: env.id }, data: { currentVersionId: v.id, draftVersionId: null, status: "APPROVED", rowVersion: { increment: 1 } } });
  await audit(tx, {
    workspaceId: env.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.actorType,
    action: "envelope.version.approved",
    entityType: "envelope",
    entityId: env.id,
    before: { versionId: env.currentVersionId },
    // approvedAt, versionNo and amountReporting let the decision timeline reconstruct any as-of from audit rows alone.
    after: { versionId: v.id, versionNo: v.versionNo, amount: v.amount.toFixed(2), amountReporting: v.amountReporting.toFixed(2), approvedAt: now.toISOString(), requestId },
    reason,
    requestId: ctx.requestId,
  });
  await outbox(tx, { workspaceId: env.workspaceId, topic: "budget.changed", payload: { envelopeId: env.id, versionId: v.id, kind: "approved" } });
  await bumpDataVersion(tx, env.workspaceId);
}
