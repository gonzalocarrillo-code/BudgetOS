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

/** When a request last had an audit event of this action (a reminder, S-004), or null. */
export async function lastRequestAuditAt(tx: Tx, requestId: string, action: string): Promise<Date | null> {
  const [row] = await tx.$queryRaw<Array<{ at: Date | null }>>`
    SELECT max(occurred_at) AS at FROM audit_event
    WHERE entity_type = 'approval_request' AND entity_id = ${requestId}::uuid AND action = ${action}`;
  return row?.at ?? null;
}

/** Who made the latest audited change to an entity (the decider, the one who withdrew), or null. */
export async function lastActorId(tx: Tx, entityType: string, entityId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<Array<{ actor: string | null }>>`
    SELECT actor_id::text AS actor FROM audit_event
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid
    ORDER BY occurred_at DESC LIMIT 1`;
  return row?.actor ?? null;
}

/**
 * Requests of the current workspace (row-level security) whose id ends with these eight hex
 * characters, newest first: the short id Slack shows (S-007). Almost always one.
 */
export async function approvalRequestsBySuffix(tx: Tx, suffix: string, limit = 5): Promise<Array<{ id: string; summary: string; status: string }>> {
  if (!/^[0-9a-f]{8}$/.test(suffix)) return [];
  return tx.$queryRaw<Array<{ id: string; summary: string; status: string }>>`
    SELECT id::text AS id, summary, status::text AS status FROM approval_request
    WHERE right(id::text, 8) = ${suffix}
    ORDER BY requested_at DESC LIMIT ${limit}`;
}
