import { dimensionValuePaths, dimensionValueStates, listFactDimensionValues, withTenant, type FactDimensionValueRow, type Tx } from "@budget/db";
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
  isActive: boolean;
  aliases: string[];
  mergedIntoId: string | null;
  externalIds: Record<string, string>;
}

export interface ListedDimension {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isActive: boolean;
  dataType: "ENUM" | "TEXT" | "REFERENCE" | "DATE_BUCKET";
  icon: string;
  color: string | null;
  allowedParents: string[];
  isRequiredForLeaf: boolean;
  workspaceId: string | null;
  sortOrder: number;
  /** EX-9 (ADR-0094): `facts` — values come from the spend data (GET …/dimensions/:key/fact-values), `values` is empty. */
  valuesSource: "registry" | "facts";
  values: ListedValue[];
}

export interface ListedTemplate {
  id: string;
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
  const states = new Map((await dimensionValueStates(tx, dimensions.map((d) => d.id))).map((r) => [r.id, r]));
  const valuesByDimension = new Map<string, ListedValue[]>();
  for (const row of paths) {
    const state = states.get(row.id);
    const current = valuesByDimension.get(row.dimensionId) ?? [];
    current.push({
      id: row.id,
      code: row.code,
      label: row.label,
      path: row.path,
      parentValueId: row.parentValueId,
      isActive: state?.isActive ?? true,
      aliases: state?.aliases ?? [],
      mergedIntoId: state?.mergedIntoId ?? null,
      externalIds: state?.externalIds ?? {},
    });
    valuesByDimension.set(row.dimensionId, current);
  }
  return dimensions.map((dimension) => ({
    id: dimension.id,
    key: dimension.key,
    label: dimension.label,
    description: dimension.description,
    isActive: dimension.isActive,
    dataType: dimension.dataType,
    icon: dimension.icon,
    color: dimension.color,
    allowedParents: dimension.allowedParents,
    isRequiredForLeaf: dimension.isRequiredForLeaf,
    workspaceId: dimension.workspaceId,
    sortOrder: dimension.sortOrder,
    valuesSource: dimension.valuesSource === "facts" ? ("facts" as const) : ("registry" as const),
    // A data-derived dimension has no hand-managed values; rows an older seed left stay in the table.
    values: dimension.valuesSource === "facts" ? [] : (valuesByDimension.get(dimension.id) ?? []),
  }));
}

export async function listHierarchyTemplates(tx: Tx, workspaceId: string): Promise<ListedTemplate[]> {
  const rows = await tx.hierarchyTemplate.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    isDefault: row.isDefault,
  }));
}

/** How many of a data-derived dimension's values (largest spend first) the registry description carries. */
export const DESCRIBED_FACT_VALUES = 100;

export type DescribedDimension = ListedDimension & { factValues?: { items: FactDimensionValueRow[]; total: number } };

/**
 * The registry an MCP client (or the web) builds filters from: dimensions with values, and hierarchy
 * templates. EX-9: a data-derived dimension (campaign) carries `factValues` instead — its first
 * DESCRIBED_FACT_VALUES values from the facts (`total` says how many there are).
 */
export async function describeRegistry(prisma: PrismaClient, auth: AuthContext, opts: { factValues?: boolean } = {}) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const listed = await listDimensions(tx, workspaceId);
    const dimensions: DescribedDimension[] = [];
    for (const d of listed) {
      if (d.valuesSource !== "facts" || opts.factValues === false) dimensions.push(d);
      else {
        const page = await listFactDimensionValues(tx, { workspaceId, key: d.key, limit: DESCRIBED_FACT_VALUES });
        dimensions.push({ ...d, factValues: { items: page.items, total: page.total } });
      }
    }
    return { dimensions, hierarchyTemplates: await listHierarchyTemplates(tx, workspaceId) };
  });
}
