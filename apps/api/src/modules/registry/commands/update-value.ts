import { DomainError, UpdateValueInput, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { assertCanEditDimension, requireDimension } from "../dimensions.js";

export async function updateValue(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  valueId: string,
  raw: unknown,
): Promise<{ id: string; label: string }> {
  assertCanManage(roles);
  const input = parseInput(UpdateValueInput, raw);
  if (Object.values(input).every((value) => value === undefined)) {
    throw new DomainError("VALIDATION", "Value update is empty");
  }
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const value = await tx.dimensionValue.findUnique({ where: { id: valueId } });
    if (value === null) {
      throw new DomainError("NOT_FOUND", "Dimension value not found");
    }
    const dimension = await requireDimension(tx, value.dimensionId, workspace.orgId);
    assertCanEditDimension(dimension, ctx);
    const updated = await tx.dimensionValue.update({
      where: { id: value.id },
      data: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.aliases === undefined ? {} : { aliases: [...input.aliases] }),
        ...(input.externalIds === undefined ? {} : { externalIds: input.externalIds }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.value.updated",
      entityType: "dimension_value",
      entityId: value.id,
      kind: "value.updated",
      after: { dimensionId: dimension.id, valueId: value.id },
    });
    return { id: updated.id, label: updated.label };
  });
}
