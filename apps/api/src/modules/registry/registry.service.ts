import { DomainError, MergeValuesInput, type Role } from "@budget/domain";
import { withTenant, type TenantContext } from "@budget/db";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ASSET_STORE, type AssetStore } from "./assets/asset-store.js";
import { addValues } from "./commands/add-values.js";
import { createDimension } from "./commands/create-dimension.js";
import { createMetric, listMetrics } from "./commands/metrics.js";
import { mergeValues } from "./commands/merge-values.js";
import { saveHierarchyTemplate, updateHierarchyTemplate } from "./commands/save-hierarchy-template.js";
import { updateDimension } from "./commands/update-dimension.js";
import { updateValue } from "./commands/update-value.js";
import { uploadAsset } from "./commands/upload-asset.js";
import { parseInput } from "./context.js";
import { listDimensions, listHierarchyTemplates } from "./queries/list-registry.js";

@Injectable()
export class RegistryService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(ASSET_STORE) private readonly assets: AssetStore,
  ) {}

  listDimensions(ctx: TenantContext, workspaceId: string) {
    return withTenant(this.prisma, { ...ctx, workspaceId }, (tx) => listDimensions(tx, workspaceId));
  }

  createDimension(ctx: TenantContext, roles: Role[], body: unknown) {
    return createDimension(this.prisma, ctx, roles, body, this.assets);
  }

  updateDimension(ctx: TenantContext, roles: Role[], dimensionId: string, body: unknown) {
    return updateDimension(this.prisma, ctx, roles, dimensionId, body, this.assets);
  }

  addValues(ctx: TenantContext, roles: Role[], dimensionId: string, body: unknown) {
    return addValues(this.prisma, ctx, roles, dimensionId, body);
  }

  updateValue(ctx: TenantContext, roles: Role[], valueId: string, body: unknown) {
    return updateValue(this.prisma, ctx, roles, valueId, body);
  }

  async mergeValue(ctx: TenantContext, roles: Role[], valueId: string, body: unknown) {
    const input = parseInput(MergeValuesInput, body);
    const dimensionId = await withTenant(this.prisma, ctx, async (tx) => {
      const value = await tx.dimensionValue.findUnique({ where: { id: valueId } });
      if (value === null) {
        throw new DomainError("NOT_FOUND", "Dimension value not found");
      }
      if (value.code !== input.fromCode) {
        throw new DomainError("VALIDATION", "Merge source does not match this value");
      }
      return value.dimensionId;
    });
    return mergeValues(this.prisma, ctx, roles, dimensionId, input);
  }

  listTemplates(ctx: TenantContext, workspaceId: string) {
    return withTenant(this.prisma, { ...ctx, workspaceId }, (tx) => listHierarchyTemplates(tx, workspaceId));
  }

  saveTemplate(ctx: TenantContext, roles: Role[], body: unknown) {
    return saveHierarchyTemplate(this.prisma, ctx, roles, body);
  }

  updateTemplate(ctx: TenantContext, roles: Role[], id: string, body: unknown) {
    return updateHierarchyTemplate(this.prisma, ctx, roles, id, body);
  }

  listMetrics(ctx: TenantContext, workspaceId: string) {
    return listMetrics(this.prisma, { ...ctx, workspaceId });
  }

  createMetric(ctx: TenantContext, roles: Role[], body: unknown) {
    return createMetric(this.prisma, ctx, roles, body);
  }

  uploadAsset(ctx: TenantContext, roles: Role[], body: unknown) {
    return uploadAsset(this.prisma, ctx, roles, body, this.assets);
  }

  /** GET /assets/icons/:file: an uploaded icon's sanitized SVG (T-031; sanitized on upload). */
  icon(file: string): { icon: string; svg: string } {
    if (!/^[0-9a-f-]{36}\.svg$/.test(file)) throw new DomainError("NOT_FOUND", "Icon not found");
    const stored = this.assets.get(`icons/${file}`);
    if (stored === undefined) throw new DomainError("NOT_FOUND", "Icon not found");
    return { icon: `asset:icons/${file}`, svg: new TextDecoder().decode(stored.body) };
  }
}
