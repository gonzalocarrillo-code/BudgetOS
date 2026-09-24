import { DomainError, newId } from "@budget/domain";
import { audit, auditMany, bumpDataVersion, insertBulkChange, insertBulkVersions, loadBulkHeads, lockEnvelopes, outbox, setDraftPointers, supersedeDrafts, withTenant, type BulkVersionRow } from "@budget/db";
import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { addHours, finalizeBulk, type PolicySnapshot } from "../../approvals/engine.js";
import { matchPolicy } from "../../approvals/policy-matcher.js";
import { resolveFx } from "../commands/version-writer.js";
import { capViolations } from "./caps.js";
import type { StoredPreview } from "./preview.js";
import type { PreviewStore } from "./preview-store.js";

export interface BulkCommitResult {
  bulkChangeId: string;
  requestId: string | null;
  autoApproved: boolean;
  policy: { name: string; version: number } | null;
  versions: number;
}

/**
 * POST /envelopes/bulk/:previewId/commit (spec §7.4). One transaction: a DRAFT version per row
 * (one set-based INSERT; phasing keeps each head's shape), set-based envelope pointer updates, one `bulk_change`, a single
 * approval request for it (or auto-approval when the policy's chain is empty), one audit_event per
 * envelope plus a summary, one outbox row `budget.changed` with `{ bulk: true, versionIds }`.
 * Any row whose head changed since the preview makes the whole commit a 409.
 */
export async function commitBulk(prisma: PrismaClient, auth: AuthContext, rawPreviewId: string, store: PreviewStore): Promise<BulkCommitResult> {
  const previewId = parseId(rawPreviewId);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const raw = await store.get(previewId);
  if (raw === null) throw new DomainError("NOT_FOUND", "Preview not found or expired; preview again");
  const p = JSON.parse(raw) as StoredPreview;
  if (p.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Preview not found or expired; preview again");
  if (p.createdBy !== auth.user.id) throw new DomainError("FORBIDDEN", "Only the author of a preview can commit it");

  const result = await withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const ids = p.rows.map((r) => r.envelopeId);
      await lockEnvelopes(tx, ids);
      const heads = new Map((await loadBulkHeads(tx, ids)).map((h) => [h.id, h]));
      const changed = p.rows
        .filter((r) => {
          const h = heads.get(r.envelopeId);
          return !h || h.headVersionId !== r.headVersionId || h.headStatus === "PENDING" || h.status === "LOCKED" || h.status === "ARCHIVED";
        })
        .map((r) => r.envelopeId);
      if (changed.length) throw new DomainError("CONFLICT", "Envelopes changed since the preview; preview again", { changed: changed.slice(0, 50), count: changed.length });

      const now = new Date();
      const fx = new Map<string, { id: string | null; rate: Decimal }>();
      for (const c of new Set(p.rows.map((r) => r.currency))) fx.set(c, await resolveFx(tx, c, workspaceId));

      const versions: BulkVersionRow[] = [];
      const pointers: Array<{ envelopeId: string; versionId: string }> = [];
      const previousDrafts: string[] = [];
      let beforeRep = new Decimal(0);
      let afterRep = new Decimal(0);
      const afterRepById = new Map<string, Decimal>();
      for (const r of p.rows) {
        const h = heads.get(r.envelopeId);
        if (!h) continue;
        const rate = fx.get(r.currency) as { id: string | null; rate: Decimal };
        const amount = new Decimal(r.after);
        const rep = amount.mul(rate.rate).toDecimalPlaces(2);
        const id = newId();
        versions.push({
          id,
          envelopeId: r.envelopeId,
          versionNo: h.maxVersionNo + 1,
          amount: amount.toFixed(2),
          amountReporting: rep.toFixed(2),
          fxRateId: rate.id,
          basedOnVersionId: h.currentVersionId,
          headVersionId: r.headVersionId,
        });
        pointers.push({ envelopeId: r.envelopeId, versionId: id });
        if (h.draftVersionId) previousDrafts.push(h.draftVersionId);
        beforeRep = beforeRep.plus(new Decimal(r.before ?? 0).mul(rate.rate).toDecimalPlaces(2));
        afterRep = afterRep.plus(rep);
        afterRepById.set(r.envelopeId, rep);
      }
      const overAllocated = (await capViolations(tx, p.rows.map((r) => ({ id: r.envelopeId, parentId: heads.get(r.envelopeId)?.parentId ?? null })), afterRepById)).length > 0;
      await insertBulkVersions(tx, versions, auth.user.id, p.rationale);
      await supersedeDrafts(tx, previousDrafts);

      const versionIds = versions.map((v) => v.id);
      const bulkChangeId = newId();
      await insertBulkChange(tx, { id: bulkChangeId, workspaceId, kind: "edit", versionIds, createdBy: auth.user.id });

      const policy = await matchPolicy(tx, workspaceId, {
        entityType: "bulk_change",
        amountAbs: afterRep,
        deltaAbs: afterRep.minus(beforeRep),
        deltaPct: beforeRep.isZero() ? new Decimal(1) : afterRep.minus(beforeRep).div(beforeRep),
        isOverAllocation: overAllocated,
        level: 0,
        dimensionValues: {},
        daysRemaining: 0,
      });
      if (policy === null) throw new DomainError("POLICY_NOT_FOUND", "No approval policy matched");

      let requestId: string | null = null;
      if (policy.chain.length === 0) {
        await setDraftPointers(tx, pointers, "DRAFT_OR_APPROVED");
      } else {
        requestId = newId();
        const snapshot: PolicySnapshot = { conditions: policy.conditionsParsed, chain: policy.chain, blockSelfApproval: policy.blockSelfApproval, allowExternalEvidence: policy.allowExternalEvidence, policyName: policy.name };
        await tx.approvalRequest.create({
          data: {
            id: requestId,
            workspaceId,
            entityType: "bulk_change",
            entityId: bulkChangeId,
            policyId: policy.id,
            policyVersion: policy.version,
            policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
            summary: `Bulk ${p.op} on ${versionIds.length} envelopes: ${beforeRep.toFixed(2)} → ${afterRep.toFixed(2)} (reporting). ${p.rationale.slice(0, 200)}`,
            requestedBy: auth.user.id,
            dueAt: addHours(now, policy.chain[0]?.timeoutHours ?? 48),
          },
        });
        await tx.envelopeVersion.updateMany({ where: { id: { in: versionIds } }, data: { status: "PENDING" } });
        await setDraftPointers(tx, pointers, "PENDING");
      }

      await auditMany(
        tx,
        p.rows.map((r, i) => ({
          workspaceId,
          actorId: auth.user.id,
          actorType: auth.ctx.actorType,
          action: "envelope.version.created",
          entityType: "envelope",
          entityId: r.envelopeId,
          before: { versionId: r.headVersionId, amount: r.before },
          after: { versionId: versionIds[i], amount: r.after, versionNo: versions[i]?.versionNo, bulkChangeId, requestId },
          reason: p.rationale,
          requestId: auth.ctx.requestId,
        })),
      );
      await audit(tx, {
        workspaceId,
        actorId: auth.user.id,
        actorType: auth.ctx.actorType,
        action: "bulk.committed",
        entityType: "bulk_change",
        entityId: bulkChangeId,
        after: { op: p.op, rows: versionIds.length, totalsBefore: beforeRep.toFixed(2), totalsAfter: afterRep.toFixed(2), requestId, policy: policy.name, policyVersion: policy.version },
        reason: p.rationale,
        requestId: auth.ctx.requestId,
      });
      await outbox(tx, { workspaceId, topic: "budget.changed", payload: { bulk: true, bulkChangeId, requestId, versionIds } });

      if (policy.chain.length === 0) {
        // Auto-approve per policy (plan §9.3), parents first so their caps are in place for children.
        await finalizeBulk(tx, auth.ctx, bulkChangeId, null, `auto-approved by policy ${policy.name} v${policy.version}`);
      }
      await bumpDataVersion(tx, workspaceId);
      return { bulkChangeId, requestId, autoApproved: policy.chain.length === 0, policy: { name: policy.name, version: policy.version }, versions: versionIds.length };
    },
    { timeoutMs: 60_000 },
  );
  await store.delete(previewId);
  return result;
}
