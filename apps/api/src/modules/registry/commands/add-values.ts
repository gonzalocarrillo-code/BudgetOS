import { AddValuesInput, DomainError, newId, type Role } from "@budget/domain";
import { upsertDimensionValue, type TenantContext } from "@budget/db";
import type { Dimension, PrismaClient } from "@prisma/client";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { assertCanEditDimension, requireDimension } from "../dimensions.js";
import type { Tx } from "@budget/db";

export interface SavedValue {
  id: string;
  code: string;
  path: string;
}

export async function addValues(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  dimensionId: string,
  raw: unknown,
): Promise<SavedValue[]> {
  assertCanManage(roles);
  const input = parseInput(AddValuesInput, raw);
  const seen = new Set<string>();
  for (const value of input.values) {
    if (seen.has(value.code)) {
      throw new DomainError("VALIDATION", `Duplicate value code ${value.code}`);
    }
    seen.add(value.code);
  }

  return inWorkspace(
    prisma,
    ctx,
    async (tx, workspace) => {
      const dimension = await requireDimension(tx, dimensionId, workspace.orgId);
      assertCanEditDimension(dimension, ctx);
      const ordered = orderValues(input.values);
      const parentIds = new Map<string, string>();
      const saved: SavedValue[] = [];
      for (const value of ordered) {
        const parentValueId = await resolveParentId(tx, dimension, ctx, value.parentCode, parentIds);
        const row = await upsertDimensionValue(tx, {
          id: newId(),
          dimensionId: dimension.id,
          code: value.code,
          label: value.label,
          parentValueId,
          aliases: value.aliases ?? [],
          externalIds: value.externalIds ?? {},
        });
        parentIds.set(value.code, row.id);
        saved.push({ id: row.id, code: value.code, path: row.path });
      }
      await recordChange(tx, ctx, {
        workspaceId: workspace.id,
        orgId: workspace.orgId,
        action: "registry.values.upserted",
        entityType: "dimension",
        entityId: dimension.id,
        kind: "values.upserted",
        after: { dimensionId: dimension.id, codes: saved.map((value) => value.code) },
      });
      return saved;
    },
    60_000,
  );
}

function orderValues<
  T extends {
    code: string;
    parentCode?: string | undefined;
    aliases?: string[] | undefined;
    externalIds?: Record<string, string> | undefined;
  },
>(values: readonly T[]): T[] {
  const byCode = new Map(values.map((value) => [value.code, value]));
  const ordered: T[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (value: T): void => {
    if (visited.has(value.code)) {
      return;
    }
    if (visiting.has(value.code)) {
      throw new DomainError("VALIDATION", `Value parent cycle at ${value.code}`);
    }
    visiting.add(value.code);
    if (value.parentCode !== undefined) {
      const parent = byCode.get(value.parentCode);
      if (parent !== undefined) {
        visit(parent);
      }
    }
    visiting.delete(value.code);
    visited.add(value.code);
    ordered.push(value);
  };
  for (const value of values) {
    visit(value);
  }
  return ordered;
}

async function resolveParentId(
  tx: Tx,
  dimension: Dimension,
  ctx: TenantContext,
  parentCode: string | undefined,
  known: Map<string, string>,
): Promise<string | null> {
  if (parentCode === undefined) {
    return null;
  }
  const cached = known.get(parentCode);
  if (cached !== undefined) {
    return cached;
  }
  const local = await tx.dimensionValue.findFirst({
    where: { dimensionId: dimension.id, code: parentCode },
  });
  if (local !== null) {
    known.set(parentCode, local.id);
    return local.id;
  }
  if (ctx.workspaceId === null) {
    throw new DomainError("VALIDATION", `Unknown parent code ${parentCode}`);
  }
  for (const key of dimension.allowedParents) {
    const parents = await tx.dimension.findMany({
      where: {
        orgId: dimension.orgId,
        key,
        isActive: true,
        OR: [{ workspaceId: null }, { workspaceId: ctx.workspaceId }],
      },
    });
    const parentDimension = parents.find((row) => row.workspaceId !== null) ?? parents.find((row) => row.workspaceId === null);
    if (parentDimension === undefined) {
      continue;
    }
    const match = await tx.dimensionValue.findFirst({
      where: { dimensionId: parentDimension.id, code: parentCode, isActive: true, mergedIntoId: null },
    });
    if (match !== null) {
      known.set(parentCode, match.id);
      return match.id;
    }
  }
  throw new DomainError("VALIDATION", `Unknown parent code ${parentCode}`);
}
