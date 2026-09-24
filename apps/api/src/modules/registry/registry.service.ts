import { DomainError, MergeValuesInput, type Role } from "@budget/domain";
import { withTenant, type TenantContext } from "@budget/db";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ASSET_STORE, type AssetStore } from "./assets/asset-store.js";
import { addValues } from "./commands/add-values.js";
import { createDimension } from "./commands/create-dimension.js";
import { mergeValues } from "./commands/merge-values.js";
import { saveHierarchyTemplate } from "./commands/save-hierarchy-template.js";
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

  uploadAsset(ctx: TenantContext, roles: Role[], body: unknown) {
    return uploadAsset(this.prisma, ctx, roles, body, this.assets);
  }
}
