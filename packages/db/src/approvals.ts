import type { Tx } from "./sql.js";

export interface LockedRequestRow {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  policyId: string;
  policyVersion: number;
  policySnapshot: unknown;
  currentStep: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "WITHDRAWN" | "ESCALATED";
  requestedBy: string;
}

/** Locks an approval request for the rest of the transaction (spec §9.3). RLS applies. */
export async function lockApprovalRequest(tx: Tx, requestId: string): Promise<LockedRequestRow | null> {
  const rows = await tx.$queryRaw<LockedRequestRow[]>`
    SELECT id::text AS id, workspace_id::text AS "workspaceId", entity_type AS "entityType", entity_id::text AS "entityId",
           policy_id::text AS "policyId", policy_version AS "policyVersion", policy_snapshot AS "policySnapshot",
           current_step AS "currentStep", status::text AS status, requested_by::text AS "requestedBy"
    FROM approval_request WHERE id = ${requestId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** SQL eligible_approver(): current step's role (direct or via group), step group, blockSelfApproval. */
export async function eligibleApproverSql(tx: Tx, requestId: string, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT eligible_approver(${requestId}::uuid, ${userId}::uuid) AS ok`;
  return rows[0]?.ok === true;
}

/**
 * Parent cap inputs (spec §7.3): locks the parent row so concurrent child approvals serialise,
 * returns its approved reporting amount and the approved sum of the other children.
 */
export async function lockParentCap(
  tx: Tx,
  parentId: string,
  excludeChildId: string,
): Promise<{ allowOverAllocation: boolean; parentAmount: string | null; siblingsSum: string } | null> {
  const [parent] = await tx.$queryRaw<Array<{ allow: boolean; amount: string | null }>>`
    SELECT p.allow_over_allocation AS allow, pv.amount_reporting::text AS amount
    FROM envelope p LEFT JOIN envelope_version pv ON pv.id = p.current_version_id
    WHERE p.id = ${parentId}::uuid FOR UPDATE OF p`;
  if (parent === undefined) return null;
  const [sib] = await tx.$queryRaw<Array<{ s: string }>>`
    SELECT coalesce(sum(cv.amount_reporting), 0)::text AS s
    FROM envelope c JOIN envelope_version cv ON cv.id = c.current_version_id
    WHERE c.parent_id = ${parentId}::uuid AND c.id <> ${excludeChildId}::uuid`;
  return { allowOverAllocation: parent.allow, parentAmount: parent.amount, siblingsSum: sib?.s ?? "0" };
}
