import { DomainError } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** DELETE /roles/:id. Only assignments of the caller's workspace; the audit row keeps the grant. */
export async function revokeRole(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const row = await tx.roleAssignment.findUnique({ where: { id } });
    if (row === null || row.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Role assignment not found");
    // ORG-005: a workspace keeps at least one admin, so its people are never locked out of it.
    if (row.role === "WORKSPACE_ADMIN" && (await tx.roleAssignment.count({ where: { workspaceId, role: "WORKSPACE_ADMIN" } })) <= 1) {
      throw new DomainError("CONFLICT", "A workspace needs at least one admin. Give someone else the Workspace admin role first.", { lastAdmin: true });
    }
    await tx.roleAssignment.delete({ where: { id } });
    const before = { principalType: row.principalType, principalId: row.principalId, role: row.role, scope: row.scope };
    await audit(tx, {
      workspaceId,
      actorId: auth.user.id,
      actorType: auth.ctx.actorType,
      action: "role.revoked",
      entityType: "role_assignment",
      entityId: id,
      before,
      requestId: auth.ctx.requestId,
    });
    await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.revoked", roleAssignmentId: id, ...before } });
    return { id, revoked: true };
  });
}
