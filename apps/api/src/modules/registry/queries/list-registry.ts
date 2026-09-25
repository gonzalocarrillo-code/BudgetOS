import { dimensionValuePaths, withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { loadDimensions } from "../dimensions.js";

export interface ListedValue {
  id: string;
  code: string;
  label: string;
  path: string;
  parentValueId: string | null;
}

export interface ListedDimension {
  id: string;
  key: string;
  label: string;
  dataType: "ENUM" | "TEXT" | "REFERENCE" | "DATE_BUCKET";
  icon: string;
  color: string | null;
  allowedParents: string[];
  isRequiredForLeaf: boolean;
  workspaceId: string | null;
  sortOrder: number;
  values: ListedValue[];
}

export interface ListedTemplate {
  name: string;
  path: string[];
  isDefault: boolean;
}

export async function listDimensions(tx: Tx, workspaceId: string): Promise<ListedDimension[]> {
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (workspace === null) {
    return [];
  }
  const dimensions = await loadDimensions(tx, workspace.orgId, workspaceId);
  const paths = await dimensionValuePaths(
    tx,
    dimensions.map((dimension) => dimension.id),
  );
  const valuesByDimension = new Map<string, ListedValue[]>();
  for (const row of paths) {
    const current = valuesByDimension.get(row.dimensionId) ?? [];
    current.push({
      id: row.id,
      code: row.code,
      label: row.label,
      path: row.path,
      parentValueId: row.parentValueId,
    });
    valuesByDimension.set(row.dimensionId, current);
  }
  return dimensions.map((dimension) => ({
    id: dimension.id,
    key: dimension.key,
    label: dimension.label,
    dataType: dimension.dataType,
    icon: dimension.icon,
    color: dimension.color,
    allowedParents: dimension.allowedParents,
    isRequiredForLeaf: dimension.isRequiredForLeaf,
    workspaceId: dimension.workspaceId,
    sortOrder: dimension.sortOrder,
    values: valuesByDimension.get(dimension.id) ?? [],
  }));
}

export async function listHierarchyTemplates(tx: Tx, workspaceId: string): Promise<ListedTemplate[]> {
  const rows = await tx.hierarchyTemplate.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({
    name: row.name,
    path: row.path,
    isDefault: row.isDefault,
  }));
}

/** The registry an MCP client (or the web) builds filters from: dimensions with values, and hierarchy templates. */
export async function describeRegistry(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => ({ dimensions: await listDimensions(tx, workspaceId), hierarchyTemplates: await listHierarchyTemplates(tx, workspaceId) }));
}
