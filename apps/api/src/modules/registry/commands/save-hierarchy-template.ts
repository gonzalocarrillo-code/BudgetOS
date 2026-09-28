import {
  DomainError,
  newId,
  SaveHierarchyTemplateInput,
  UpdateHierarchyTemplateInput,
  type Role,
} from "@budget/domain";
import type { TenantContext, Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import {
  assertCanManage,
  inWorkspace,
  parseInput,
  recordChange,
} from "../context.js";
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
    await assertPath(tx, workspace.orgId, workspace.id, input.path);
    const existing = await tx.hierarchyTemplate.findFirst({
      where: { workspaceId: workspace.id, name: input.name },
    });
    if (existing !== null) {
      throw new DomainError(
        "CONFLICT",
        `Hierarchy template ${input.name} already exists`,
      );
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

/**
 * Every key is an active dimension, once. Levels nest in any order (product feedback 2026-09-28,
 * ADR-049): a dimension's allowedParents is about its *values* (a country value under a region
 * value), not where its level sits in a tree.
 */
async function assertPath(
  tx: Tx,
  orgId: string,
  workspaceId: string,
  path: readonly string[],
): Promise<void> {
  const visible = await loadDimensions(tx, orgId, workspaceId);
  const active = new Set(
    visible.filter((dimension) => dimension.isActive).map((dimension) => dimension.key),
  );
  for (const key of path) {
    if (!active.has(key)) {
      throw new DomainError("VALIDATION", `Unknown dimension ${key}`);
    }
  }
  if (new Set(path).size !== path.length) {
    throw new DomainError("VALIDATION", "A granularity can appear only once in a hierarchy");
  }
}

/** PATCH /hierarchy-templates/:id: rename, reorder, or make default. Envelopes do not change, only the tree does. */
export async function updateHierarchyTemplate(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  id: string,
  raw: unknown,
): Promise<{ id: string; name: string; path: string[]; isDefault: boolean }> {
  assertCanManage(roles);
  const input = parseInput(UpdateHierarchyTemplateInput, raw);
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const before = await tx.hierarchyTemplate.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (before === null)
      throw new DomainError("NOT_FOUND", "Hierarchy template not found");
    if (input.path !== undefined)
      await assertPath(tx, workspace.orgId, workspace.id, input.path);
    if (input.name !== undefined && input.name !== before.name) {
      const clash = await tx.hierarchyTemplate.findFirst({
        where: { workspaceId: workspace.id, name: input.name },
      });
      if (clash !== null)
        throw new DomainError(
          "CONFLICT",
          `Hierarchy template ${input.name} already exists`,
        );
    }
    if (input.isDefault)
      await tx.hierarchyTemplate.updateMany({
        where: { workspaceId: workspace.id, isDefault: true },
        data: { isDefault: false },
      });
    const row = await tx.hierarchyTemplate.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.path === undefined ? {} : { path: [...input.path] }),
        ...(input.isDefault ? { isDefault: true } : {}),
      },
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.template.updated",
      entityType: "hierarchy_template",
      entityId: id,
      kind: "template.saved",
      before: {
        name: before.name,
        path: before.path,
        isDefault: before.isDefault,
      },
      after: {
        templateId: id,
        name: row.name,
        path: row.path,
        isDefault: row.isDefault,
      },
    });
    return { id, name: row.name, path: row.path, isDefault: row.isDefault };
  });
}
