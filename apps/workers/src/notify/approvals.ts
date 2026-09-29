import { eligibleApproverSql, type Tx } from "@budget/db";

/**
 * What an approval event means for the people told about it, shared by the in-app and Slack
 * consumers: the kind of message, and who may decide the step the request now waits on.
 */

export type ApprovalKind = "requested" | "approved" | "rejected" | "changes_requested" | "withdrawn" | "escalated";

const BY_ACTION: Record<string, ApprovalKind | undefined> = {
  "approval.requested": "requested",
  "approval.escalated": "escalated",
  "approval.withdrawn": "withdrawn",
};
const OUTCOME: Record<string, ApprovalKind | undefined> = { APPROVED: "approved", REJECTED: "rejected", CHANGES_REQUESTED: "changes_requested" };

/**
 * The kind worth telling people about: new requests, escalations and final outcomes, and (S-004)
 * an approval that completed its step, since the request now waits on the next step's approvers.
 * An approval that leaves the step waiting for more approvals is nothing new. Pass the request's
 * current step to recognise a step change (the event names the step that was decided).
 */
export function approvalKind(p: Record<string, unknown>, request?: { currentStep: number } | null): ApprovalKind | undefined {
  const action = String(p["action"] ?? "");
  const kind = BY_ACTION[action] ?? (action.startsWith("approval.") && typeof p["status"] === "string" ? OUTCOME[p["status"]] : undefined);
  if (kind) return kind;
  if (action === "approval.approve" && p["status"] === "PENDING" && request && typeof p["step"] === "number" && request.currentStep > p["step"]) return "requested";
  return undefined;
}

/**
 * Users who may decide the request's current step: the step role in this workspace (directly or
 * through a group), filtered by eligible_approver() (role, step group, self-approval). Dimension
 * scope is checked when they act (the inbox and decide() filter by it). Admins who do not hold the
 * step role are not told, although they may decide.
 */
export async function stepApprovers(tx: Tx, workspaceId: string, requestId: string): Promise<string[]> {
  const r = await tx.approvalRequest.findUnique({ where: { id: requestId } });
  const role = ((r?.policySnapshot ?? {}) as { chain?: Array<{ role?: string }> }).chain?.[r?.currentStep ?? 0]?.role;
  if (!r || !role) return [];
  const assignments = await tx.roleAssignment.findMany({ where: { workspaceId, role: role as "APPROVER" }, select: { principalType: true, principalId: true } });
  const direct = assignments.filter((a) => a.principalType === "user").map((a) => a.principalId);
  const groupIds = assignments.filter((a) => a.principalType === "group").map((a) => a.principalId);
  const viaGroups = groupIds.length ? (await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })).map((m) => m.userId) : [];
  const out: string[] = [];
  for (const u of [...new Set([...direct, ...viaGroups])].sort()) if (await eligibleApproverSql(tx, r.id, u)) out.push(u);
  return out;
}
