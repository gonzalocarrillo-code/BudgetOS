import { AssignRoleInput, DomainError, newId } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** POST /workspaces/:ws/roles. The principal must belong to the workspace's org. */
export async function assignRole(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(AssignRoleInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const principal =
      input.principalType === "user"
        ? await tx.user.findFirst({ where: { id: input.principalId, orgId: auth.user.orgId }, select: { id: true } })
        : await tx.group.findFirst({ where: { id: input.principalId, orgId: auth.user.orgId }, select: { id: true } });
    if (principal === null) throw new DomainError("NOT_FOUND", `${input.principalType} not found`);
    const duplicate = await tx.roleAssignment.findFirst({
      where: { workspaceId, principalType: input.principalType, principalId: input.principalId, role: input.role },
      select: { id: true },
    });
    if (duplicate !== null) throw new DomainError("CONFLICT", "Role already assigned", { roleAssignmentId: duplicate.id });
    const row = await tx.roleAssignment.create({
      data: {
        id: newId(),
        workspaceId,
        principalType: input.principalType,
        principalId: input.principalId,
        role: input.role,
        scope: input.scope as Prisma.InputJsonObject,
        createdBy: auth.user.id,
      },
    });
    const after = { principalType: row.principalType, principalId: row.principalId, role: row.role, scope: input.scope };
    await audit(tx, {
      workspaceId,
      actorId: auth.user.id,
      actorType: auth.ctx.actorType,
      action: "role.assigned",
      entityType: "role_assignment",
      entityId: row.id,
      after,
      requestId: auth.ctx.requestId,
    });
    await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.assigned", roleAssignmentId: row.id, ...after } });
    return row;
  });
}
