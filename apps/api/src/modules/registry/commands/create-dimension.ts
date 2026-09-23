import { CreateDimensionInput, DomainError, newId, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { AssetStore } from "../assets/asset-store.js";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { loadDimensions } from "../dimensions.js";
import { assertIcon } from "../icons.js";

export interface CreatedDimension {
  id: string;
  key: string;
  label: string;
  icon: string;
  version: number;
}

export async function createDimension(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  raw: unknown,
  store: AssetStore,
): Promise<CreatedDimension> {
  assertCanManage(roles);
  const input = parseInput(CreateDimensionInput, raw);
  const allowedParents = input.allowedParents ?? [];
  const isRequiredForLeaf = input.isRequiredForLeaf ?? false;
  const sortOrder = input.sortOrder ?? 0;
  assertIcon(input.icon, store);
  if (input.workspaceId === null && !ctx.isOrgAdmin) {
    throw new DomainError("FORBIDDEN", "Only an org admin can create an org-wide dimension");
  }
  if (input.workspaceId !== null && input.workspaceId !== ctx.workspaceId && !ctx.isOrgAdmin) {
    throw new DomainError("FORBIDDEN", "Cannot manage another workspace registry");
  }

  return inWorkspace(prisma, ctx, async (tx, workspace, actorId) => {
    const visible = await loadDimensions(tx, workspace.orgId, workspace.id);
    const byKey = new Map(visible.map((dimension) => [dimension.key, dimension]));
    for (const parentKey of allowedParents) {
      const parent = byKey.get(parentKey);
      if (parent === undefined || !parent.isActive) {
        throw new DomainError("VALIDATION", `Unknown parent dimension ${parentKey}`);
      }
    }
    const existing = await tx.dimension.findFirst({
      where: { orgId: workspace.orgId, key: input.key, workspaceId: input.workspaceId },
    });
    if (existing !== null) {
      throw new DomainError("CONFLICT", `Dimension ${input.key} already exists`);
    }

    const id = newId();
    await tx.dimension.create({
      data: {
        id,
        orgId: workspace.orgId,
        ...(input.workspaceId === null ? {} : { workspaceId: input.workspaceId }),
        key: input.key,
        label: input.label,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.color === undefined ? {} : { color: input.color }),
        dataType: input.dataType,
        icon: input.icon,
        allowedParents,
        isRequiredForLeaf,
        sortOrder,
        createdBy: actorId,
      },
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.dimension.created",
      entityType: "dimension",
      entityId: id,
      kind: "dimension.created",
      after: { dimensionId: id, key: input.key },
    });
    return { id, key: input.key, label: input.label, icon: input.icon, version: 1 };
  });
}
