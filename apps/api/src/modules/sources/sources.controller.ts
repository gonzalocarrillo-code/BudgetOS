import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateSourceDto, CreateUploadDto, MapUnmatchedDto, RunSourceDto, UpdateSourceDto } from "./dto.js";
import { SourcesService } from "./sources.service.js";

/** Ingestion sources (spec §14, §17). Entity routes take the workspace from X-Workspace-Id. */
@Controller()
export class SourcesController {
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  @Get("workspaces/:ws/sources")
  @Permission("source.manage")
  list(@Tenant() auth: AuthContext) {
    return this.sources.list(auth);
  }

  @Post("workspaces/:ws/sources")
  @Permission("source.manage")
  create(@Tenant() auth: AuthContext, @Body() body: CreateSourceDto) {
    return this.sources.create(auth, body);
  }

  @Patch("sources/:id")
  @Permission("source.manage")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateSourceDto) {
    return this.sources.update(auth, id, body);
  }

  @Post("sources/:id/suggest-mapping")
  @Permission("source.manage")
  suggestMapping(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.sources.suggestMapping(auth, id);
  }

  @Post("sources/:id/run")
  @Permission("source.manage")
  run(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: RunSourceDto) {
    return this.sources.run(auth, id, body);
  }

  @Get("sources/:id/runs")
  @Permission("source.manage")
  runs(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.sources.runs(auth, id);
  }

  @Get("workspaces/:ws/unmatched-spend")
  @Permission("source.manage")
  unmatched(@Tenant() auth: AuthContext, @Query("limit") limit?: string) {
    return this.sources.unmatched(auth, limit);
  }

  @Post("workspaces/:ws/unmatched-spend/map")
  @Permission("source.manage")
  mapUnmatched(@Tenant() auth: AuthContext, @Body() body: MapUnmatchedDto) {
    return this.sources.mapUnmatched(auth, body);
  }

  @Post("uploads")
  @Permission("source.manage")
  upload(@Tenant() auth: AuthContext, @Body() body: CreateUploadDto) {
    return this.sources.upload(auth, body);
  }
}
