import { DomainError } from "@budget/domain";
import type { TenantContext, Tx } from "@budget/db";
import type { Dimension } from "@prisma/client";

export async function loadDimensions(tx: Tx, orgId: string, workspaceId: string): Promise<Dimension[]> {
  const rows = await tx.dimension.findMany({
    where: {
      orgId,
      OR: [{ workspaceId: null }, { workspaceId }],
    },
  });
  const byKey = new Map<string, Dimension>();
  for (const row of rows) {
    const current = byKey.get(row.key);
    if (current === undefined || row.workspaceId !== null) {
      byKey.set(row.key, row);
    }
  }
  return [...byKey.values()].sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
}

export function assertCanEditDimension(dimension: { workspaceId: string | null }, ctx: TenantContext): void {
  if (dimension.workspaceId === null) {
    if (!ctx.isOrgAdmin) {
      throw new DomainError("FORBIDDEN", "Only an org admin can change an org-wide dimension");
    }
    return;
  }
  if (dimension.workspaceId !== ctx.workspaceId && !ctx.isOrgAdmin) {
    throw new DomainError("FORBIDDEN", "Cannot manage another workspace registry");
  }
}

export async function requireDimension(tx: Tx, dimensionId: string, orgId: string): Promise<Dimension> {
  const dimension = await tx.dimension.findUnique({ where: { id: dimensionId } });
  if (dimension === null || dimension.orgId !== orgId) {
    throw new DomainError("NOT_FOUND", "Dimension not found");
  }
  return dimension;
}
