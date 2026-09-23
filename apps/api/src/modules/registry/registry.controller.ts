import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { REGISTRY_ACTOR, type RegistryActor } from "./registry.actor.js";
import { RegistryService } from "./registry.service.js";
import {
  AddValuesDto,
  CreateDimensionDto,
  MergeValuesDto,
  SaveHierarchyTemplateDto,
  UpdateDimensionDto,
  UpdateValueDto,
  UploadAssetDto,
} from "./dto.js";

@Controller()
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    @Inject(REGISTRY_ACTOR) private readonly actor: RegistryActor,
  ) {}

  @Get("workspaces/:ws/dimensions")
  listDimensions(@Param("ws") workspaceId: string) {
    const { ctx } = this.actor.current(workspaceId);
    return this.registry.listDimensions(ctx, workspaceId);
  }

  @Post("workspaces/:ws/dimensions")
  createDimension(@Param("ws") workspaceId: string, @Body() body: CreateDimensionDto) {
    const { ctx, roles } = this.actor.current(workspaceId);
    return this.registry.createDimension(ctx, roles, body);
  }

  @Patch("dimensions/:id")
  updateDimension(@Param("id") dimensionId: string, @Body() body: UpdateDimensionDto) {
    const { ctx, roles } = this.actor.current(null);
    return this.registry.updateDimension(ctx, roles, dimensionId, body);
  }

  @Post("dimensions/:id/values")
  addValues(@Param("id") dimensionId: string, @Body() body: AddValuesDto) {
    const { ctx, roles } = this.actor.current(null);
    return this.registry.addValues(ctx, roles, dimensionId, body);
  }

  @Patch("values/:id")
  updateValue(@Param("id") valueId: string, @Body() body: UpdateValueDto) {
    const { ctx, roles } = this.actor.current(null);
    return this.registry.updateValue(ctx, roles, valueId, body);
  }

  @Post("values/:id/merge")
  mergeValue(@Param("id") valueId: string, @Body() body: MergeValuesDto) {
    const { ctx, roles } = this.actor.current(null);
    return this.registry.mergeValue(ctx, roles, valueId, body);
  }

  @Get("workspaces/:ws/hierarchy-templates")
  listTemplates(@Param("ws") workspaceId: string) {
    const { ctx } = this.actor.current(workspaceId);
    return this.registry.listTemplates(ctx, workspaceId);
  }

  @Post("workspaces/:ws/hierarchy-templates")
  saveTemplate(@Param("ws") workspaceId: string, @Body() body: SaveHierarchyTemplateDto) {
    const { ctx, roles } = this.actor.current(workspaceId);
    return this.registry.saveTemplate(ctx, roles, body);
  }

  @Post("assets")
  uploadAsset(@Body() body: UploadAssetDto) {
    const { ctx, roles } = this.actor.current(null);
    return this.registry.uploadAsset(ctx, roles, body);
  }
}
