import { DEFAULT_DIMENSIONS, DEFAULT_HIERARCHY, type TenantContext } from "@budget/db";
import { DomainError, type Role } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import type { AssetStore } from "../assets/asset-store.js";
import { addValues } from "./add-values.js";
import { createDimension } from "./create-dimension.js";
import { saveHierarchyTemplate } from "./save-hierarchy-template.js";

export async function seedDefaultRegistry(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  store: AssetStore,
): Promise<void> {
  if (!ctx.isOrgAdmin) {
    throw new DomainError("FORBIDDEN", "Only an org admin can seed the default registry");
  }
  const ids = new Map<string, string>();
  for (const dimension of DEFAULT_DIMENSIONS) {
    const created = await createDimension(
      prisma,
      ctx,
      roles,
      {
        key: dimension.key,
        label: dimension.label,
        dataType: dimension.dataType,
        icon: dimension.icon,
        allowedParents: [...dimension.allowedParents],
        isRequiredForLeaf: dimension.isRequiredForLeaf,
        sortOrder: dimension.sortOrder,
        workspaceId: null,
      },
      store,
    );
    ids.set(dimension.key, created.id);
  }
  for (const dimension of DEFAULT_DIMENSIONS) {
    if (dimension.values.length === 0) {
      continue;
    }
    const dimensionId = ids.get(dimension.key);
    if (dimensionId === undefined) {
      throw new DomainError("NOT_FOUND", `Dimension ${dimension.key} was not seeded`);
    }
    await addValues(
      prisma,
      ctx,
      roles,
      dimensionId,
      {
        values: dimension.values.map((value) => ({
          code: value.code,
          label: value.label,
          ...(value.parentCode === undefined ? {} : { parentCode: value.parentCode }),
        })),
      },
    );
  }
  await saveHierarchyTemplate(prisma, ctx, roles, {
    name: DEFAULT_HIERARCHY.name,
    path: [...DEFAULT_HIERARCHY.path],
    isDefault: DEFAULT_HIERARCHY.isDefault,
  });
}
