import { DomainError } from "@budget/domain";
import type { TenantContext, Tx } from "@budget/db";
import { clock } from "../../../common/clock.js";
import { recordTargetChange } from "./target-writer.js";

/**
 * Approve a target version (spec §10): the last approval step or auto-approve. The previous current
 * version is superseded, never updated or deleted.
 */
export async function approveTargetVersion(tx: Tx, ctx: TenantContext, versionId: string, requestId: string | null, reason: string): Promise<void> {
  const v = await tx.targetVersion.findUnique({ where: { id: versionId }, include: { target: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Target version not found");
  const t = v.target;
  const now = clock.now();
  if (t.currentVersionId) await tx.targetVersion.update({ where: { id: t.currentVersionId }, data: { status: "SUPERSEDED" } });
  await tx.targetVersion.update({ where: { id: v.id }, data: { status: "APPROVED", approvedAt: now, approvalRequestId: requestId } });
  await tx.target.update({ where: { id: t.id }, data: { currentVersionId: v.id, draftVersionId: null } });
  await recordTargetChange(tx, ctx, {
    workspaceId: t.workspaceId,
    targetId: t.id,
    action: "target.version.approved",
    kind: "approved",
    before: { versionId: t.currentVersionId },
    after: { versionId: v.id, versionNo: v.versionNo, value: v.value.toString(), comparator: v.comparator, approvedAt: now.toISOString(), requestId },
    reason,
  });
}
