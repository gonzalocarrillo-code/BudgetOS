import { DomainError } from "@budget/domain";
import type { Tx } from "@budget/db";
import { loadDimensions } from "../dimensions.js";

export async function validateTuple(
  tx: Tx,
  workspaceId: string,
  dimensionValues: Record<string, string>,
): Promise<{ ok: true; valueIds: Record<string, string> }> {
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (workspace === null) {
    throw new DomainError("NOT_FOUND", "Workspace not found");
  }
  const active = (await loadDimensions(tx, workspace.orgId, workspaceId)).filter((dimension) => dimension.isActive);
  const byKey = new Map(active.map((dimension) => [dimension.key, dimension]));
  const valueIds: Record<string, string> = {};
  for (const [key, code] of Object.entries(dimensionValues)) {
    const dimension = byKey.get(key);
    if (dimension === undefined) {
      throw new DomainError("VALIDATION", `Unknown dimension ${key}`);
    }
    const value = await tx.dimensionValue.findFirst({
      where: { dimensionId: dimension.id, code, isActive: true, mergedIntoId: null },
    });
    if (value === null) {
      throw new DomainError("VALIDATION", `Unknown value ${code} for ${key}`);
    }
    valueIds[key] = value.id;
  }
  for (const dimension of active) {
    if (dimension.isRequiredForLeaf && dimensionValues[dimension.key] === undefined) {
      throw new DomainError("VALIDATION", `${dimension.key} is required for a leaf envelope`);
    }
  }
  const dimensionIds = active.map((dimension) => dimension.id);
  const constraints =
    dimensionIds.length === 0
      ? []
      : await tx.valueConstraint.findMany({ where: { dimensionId: { in: dimensionIds } } });
  const keyById = new Map(active.map((dimension) => [dimension.id, dimension.key]));
  for (const constraint of constraints) {
    if (dimensionValues[constraint.whenDimensionKey] !== constraint.whenValueCode) {
      continue;
    }
    const key = keyById.get(constraint.dimensionId);
    if (key === undefined) {
      continue;
    }
    const code = dimensionValues[key];
    if (code === undefined || constraint.allowedValueCodes.includes(code)) {
      continue;
    }
    throw new DomainError(
      "VALIDATION",
      `${key} value ${code} is not allowed when ${constraint.whenDimensionKey} is ${constraint.whenValueCode}`,
    );
  }
  return { ok: true, valueIds };
}
