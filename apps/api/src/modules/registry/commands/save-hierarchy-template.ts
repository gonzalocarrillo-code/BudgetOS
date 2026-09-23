import { DomainError, newId, SaveHierarchyTemplateInput, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { loadDimensions } from "../dimensions.js";

export async function saveHierarchyTemplate(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  raw: unknown,
): Promise<{ id: string; name: string; path: string[]; isDefault: boolean }> {
  assertCanManage(roles);
  const input = parseInput(SaveHierarchyTemplateInput, raw);
  const isDefault = input.isDefault ?? false;
  return inWorkspace(prisma, ctx, async (tx, workspace, actorId) => {
    const visible = await loadDimensions(tx, workspace.orgId, workspace.id);
    const byKey = new Map(visible.filter((dimension) => dimension.isActive).map((dimension) => [dimension.key, dimension]));
    for (const key of input.path) {
      if (!byKey.has(key)) {
        throw new DomainError("VALIDATION", `Unknown dimension ${key}`);
      }
    }
    for (let index = 1; index < input.path.length; index += 1) {
      const parentKey = input.path[index - 1];
      const childKey = input.path[index];
      if (parentKey === undefined || childKey === undefined) {
        throw new DomainError("VALIDATION", "Hierarchy path is incomplete");
      }
      const child = byKey.get(childKey);
      if (child === undefined) {
        throw new DomainError("VALIDATION", `Unknown dimension ${childKey}`);
      }
      if (child.allowedParents.length > 0 && !child.allowedParents.includes(parentKey)) {
        throw new DomainError("VALIDATION", `${childKey} cannot nest under ${parentKey}`);
      }
    }
    const existing = await tx.hierarchyTemplate.findFirst({
      where: { workspaceId: workspace.id, name: input.name },
    });
    if (existing !== null) {
      throw new DomainError("CONFLICT", `Hierarchy template ${input.name} already exists`);
    }
    if (isDefault) {
      await tx.hierarchyTemplate.updateMany({
        where: { workspaceId: workspace.id, isDefault: true },
        data: { isDefault: false },
      });
    }
    const id = newId();
    await tx.hierarchyTemplate.create({
      data: {
        id,
        workspaceId: workspace.id,
        name: input.name,
        path: [...input.path],
        isDefault,
        createdBy: actorId,
      },
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.template.saved",
      entityType: "hierarchy_template",
      entityId: id,
      kind: "template.saved",
      after: { templateId: id, name: input.name, path: [...input.path] },
    });
    return { id, name: input.name, path: [...input.path], isDefault };
  });
}
