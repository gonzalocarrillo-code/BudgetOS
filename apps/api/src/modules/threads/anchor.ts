import { DomainError, canInScope, eligibleApprover, type AnchorType, type Role, type ScopeTarget } from "@budget/domain";
import { eligibleApproverSql, type Tx } from "@budget/db";
import { envelopeScopeTarget } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";
import { OPEN_STATUSES, PolicySnapshot, requestTargets } from "../approvals/read.js";
import { targetScope } from "../targets/scope.js";

/**
 * What a thread anchor means for permissions (spec §13): the dimension scopes a reader must cover
 * (null = any workspace member may read, e.g. a registry value or a closure), the anchor's owners,
 * and the approval requests open on it, whose eligible approvers may resolve threads.
 */
export interface ResolvedAnchor {
  scopes: ScopeTarget[] | null;
  ownerIds: string[];
  openRequestIds: string[];
}

const requestsOn = async (tx: Tx, entityType: string, entityIds: string[]) =>
  (await tx.approvalRequest.findMany({ where: { entityType, entityId: { in: entityIds }, status: { in: [...OPEN_STATUSES] } }, select: { id: true } })).map((r) => r.id);

async function envelopeAnchor(tx: Tx, workspaceId: string, envelopeId: string): Promise<ResolvedAnchor> {
  const env = await tx.envelope.findUnique({ where: { id: envelopeId }, select: { workspaceId: true, ownerId: true } });
  if (env === null || env.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Anchor not found");
  const versions = (await tx.envelopeVersion.findMany({ where: { envelopeId }, select: { id: true } })).map((v) => v.id);
  return { scopes: [await envelopeScopeTarget(tx, envelopeId)], ownerIds: env.ownerId ? [env.ownerId] : [], openRequestIds: await requestsOn(tx, "envelope_version", versions) };
}

export async function resolveAnchor(tx: Tx, workspaceId: string, anchorType: AnchorType, anchorId: string): Promise<ResolvedAnchor> {
  switch (anchorType) {
    case "envelope":
    case "cell":
      return envelopeAnchor(tx, workspaceId, anchorId);
    case "envelope_version": {
      const v = await tx.envelopeVersion.findUnique({ where: { id: anchorId }, select: { envelopeId: true } });
      if (v === null) throw new DomainError("NOT_FOUND", "Anchor not found");
      return envelopeAnchor(tx, workspaceId, v.envelopeId);
    }
    case "target": {
      const t = await tx.target.findUnique({ where: { id: anchorId } });
      if (t === null || t.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Anchor not found");
      const versions = (await tx.targetVersion.findMany({ where: { targetId: t.id }, select: { id: true } })).map((v) => v.id);
      return { scopes: [await targetScope(tx, t)], ownerIds: t.ownerId ? [t.ownerId] : [], openRequestIds: await requestsOn(tx, "target_version", versions) };
    }
    case "approval_request":
    case "diff_field": {
      const r = await tx.approvalRequest.findUnique({ where: { id: anchorId } });
      if (r === null || r.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Anchor not found");
      const targets = await requestTargets(tx, r);
      return { scopes: targets.scopes, ownerIds: [r.requestedBy], openRequestIds: (OPEN_STATUSES as readonly string[]).includes(r.status) ? [r.id] : [] };
    }
    case "alert": {
      const a = await tx.alert.findUnique({ where: { id: anchorId }, select: { workspaceId: true, envelopeId: true, ownerId: true } });
      if (a === null || a.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Anchor not found");
      return { scopes: [await envelopeScopeTarget(tx, a.envelopeId)], ownerIds: a.ownerId ? [a.ownerId] : [], openRequestIds: [] };
    }
    case "closure": {
      const c = await tx.periodClosure.findUnique({ where: { id: anchorId }, select: { workspaceId: true, closedBy: true } });
      if (c === null || c.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Anchor not found");
      return { scopes: null, ownerIds: [c.closedBy], openRequestIds: [] };
    }
    case "dimension_value": {
      const v = await tx.dimensionValue.findUnique({ where: { id: anchorId }, select: { id: true } }); // RLS: the org's registry
      if (v === null) throw new DomainError("NOT_FOUND", "Anchor not found");
      return { scopes: null, ownerIds: [], openRequestIds: [] };
    }
  }
}

/** Read on the anchor (spec §13 `thread.comment`): the role grants the action in every anchor scope. */
export function assertCanRead(auth: AuthContext, anchor: ResolvedAnchor): void {
  if (auth.isOrgAdmin || anchor.scopes === null) return;
  if (!anchor.scopes.every((t) => canInScope(auth.assignments, "thread.comment", t))) throw new DomainError("FORBIDDEN", "No access to this thread's anchor");
}

/** An eligible approver of the current step of any open request on the anchor. */
export async function isEligibleApprover(tx: Tx, auth: AuthContext, requestIds: string[]): Promise<boolean> {
  for (const id of requestIds) {
    const r = await tx.approvalRequest.findUnique({ where: { id } });
    if (r === null) continue;
    const snapshot = PolicySnapshot.safeParse(r.policySnapshot);
    const step = snapshot.success ? snapshot.data.chain[r.currentStep] : undefined;
    if (!snapshot.success || step === undefined || !(await eligibleApproverSql(tx, r.id, auth.user.id))) continue;
    const targets = await requestTargets(tx, r);
    if (targets.scopes.every((target) => eligibleApprover({ assignments: auth.assignments, stepRole: step.role as Role, target, userId: auth.user.id, authorId: targets.authorId, blockSelfApproval: false }))) return true;
  }
  return false;
}
