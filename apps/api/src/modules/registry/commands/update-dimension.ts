import { DomainError, UpdateDimensionInput, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { AssetStore } from "../assets/asset-store.js";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { assertCanEditDimension, loadDimensions, requireDimension } from "../dimensions.js";
import { assertIcon } from "../icons.js";

export interface UpdatedDimension {
  id: string;
  label: string;
  icon: string;
  version: number;
}

export async function updateDimension(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  dimensionId: string,
  raw: unknown,
  store: AssetStore,
): Promise<UpdatedDimension> {
  assertCanManage(roles);
  const input = parseInput(UpdateDimensionInput, raw);
  if (Object.values(input).every((value) => value === undefined)) {
    throw new DomainError("VALIDATION", "Dimension update is empty");
  }
  if (input.icon !== undefined) {
    assertIcon(input.icon, store);
  }

  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const dimension = await requireDimension(tx, dimensionId, workspace.orgId);
    assertCanEditDimension(dimension, ctx);
    if (input.allowedParents !== undefined) {
      const visible = await loadDimensions(tx, workspace.orgId, workspace.id);
      const byKey = new Map(visible.map((row) => [row.key, row]));
      for (const parentKey of input.allowedParents) {
        if (parentKey === dimension.key) {
          throw new DomainError("VALIDATION", "A dimension cannot list itself as a parent");
        }
        const parent = byKey.get(parentKey);
        if (parent === undefined || !parent.isActive) {
          throw new DomainError("VALIDATION", `Unknown parent dimension ${parentKey}`);
        }
      }
    }
    const updated = await tx.dimension.update({
      where: { id: dimension.id },
      data: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.allowedParents === undefined ? {} : { allowedParents: [...input.allowedParents] }),
        ...(input.isRequiredForLeaf === undefined ? {} : { isRequiredForLeaf: input.isRequiredForLeaf }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        version: { increment: 1 },
      },
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.dimension.updated",
      entityType: "dimension",
      entityId: dimension.id,
      kind: "dimension.updated",
      after: { dimensionId: dimension.id, version: updated.version },
    });
    return { id: updated.id, label: updated.label, icon: updated.icon, version: updated.version };
  });
}
