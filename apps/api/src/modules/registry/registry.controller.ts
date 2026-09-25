import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, orgAdminCtx, type AuthContext } from "../../common/tenant.js";
import { RegistryService } from "./registry.service.js";
import {
  AddValuesDto,
  CreateDimensionDto,
  CreateMetricDto,
  MergeValuesDto,
  SaveHierarchyTemplateDto,
  UpdateDimensionDto,
  UpdateHierarchyTemplateDto,
  UpdateValueDto,
  UploadAssetDto,
} from "./dto.js";

@Controller()
export class RegistryController {
  constructor(@Inject(RegistryService) private readonly registry: RegistryService) {}

  @Get("workspaces/:ws/dimensions")
  @Permission("workspace.member")
  listDimensions(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string) {
    const ctx = orgAdminCtx(auth);
    return this.registry.listDimensions(ctx, workspaceId);
  }

  @Post("workspaces/:ws/dimensions")
  @Permission("registry.manage")
  createDimension(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string, @Body() body: CreateDimensionDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.createDimension(ctx, roles, body);
  }

  @Patch("dimensions/:id")
  @Permission("registry.manage")
  updateDimension(@Tenant() auth: AuthContext, @Param("id") dimensionId: string, @Body() body: UpdateDimensionDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.updateDimension(ctx, roles, dimensionId, body);
  }

  @Post("dimensions/:id/values")
  @Permission("registry.manage")
  addValues(@Tenant() auth: AuthContext, @Param("id") dimensionId: string, @Body() body: AddValuesDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.addValues(ctx, roles, dimensionId, body);
  }

  @Patch("values/:id")
  @Permission("registry.manage")
  updateValue(@Tenant() auth: AuthContext, @Param("id") valueId: string, @Body() body: UpdateValueDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.updateValue(ctx, roles, valueId, body);
  }

  @Post("values/:id/merge")
  @Permission("registry.manage")
  mergeValue(@Tenant() auth: AuthContext, @Param("id") valueId: string, @Body() body: MergeValuesDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.mergeValue(ctx, roles, valueId, body);
  }

  @Get("workspaces/:ws/hierarchy-templates")
  @Permission("workspace.member")
  listTemplates(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string) {
    const ctx = orgAdminCtx(auth);
    return this.registry.listTemplates(ctx, workspaceId);
  }

  @Post("workspaces/:ws/hierarchy-templates")
  @Permission("registry.manage")
  saveTemplate(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string, @Body() body: SaveHierarchyTemplateDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.saveTemplate(ctx, roles, body);
  }

  @Patch("hierarchy-templates/:id")
  @Permission("registry.manage")
  updateTemplate(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateHierarchyTemplateDto) {
    return this.registry.updateTemplate(orgAdminCtx(auth), auth.roles, id, body);
  }

  @Get("workspaces/:ws/metrics")
  @Permission("workspace.member")
  listMetrics(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string) {
    const ctx = orgAdminCtx(auth);
    return this.registry.listMetrics(ctx, workspaceId);
  }

  @Post("workspaces/:ws/metrics")
  @Permission("registry.manage")
  createMetric(@Tenant() auth: AuthContext, @Param("ws") workspaceId: string, @Body() body: CreateMetricDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.createMetric(ctx, roles, body);
  }

  @Get("assets/icons/:file")
  @Permission("workspace.member")
  icon(@Param("file") file: string) {
    return this.registry.icon(file);
  }

  @Post("assets")
  @Permission("registry.manage")
  uploadAsset(@Tenant() auth: AuthContext, @Body() body: UploadAssetDto) {
    const { roles } = auth;
    const ctx = orgAdminCtx(auth);
    return this.registry.uploadAsset(ctx, roles, body);
  }
}
