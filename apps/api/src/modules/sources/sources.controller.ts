import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { RateLimit } from "../../common/rate-limit.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateMappingProfileDto, CreateMappingSynonymDto, CreateSourceDto, CreateUploadDto, MapUnmatchedDto, MappingPreviewDto, MatchMappingProfileDto, RunSourceDto, SuggestMappingSampleDto, UpdateMappingProfileDto, UpdateMappingSynonymDto, UpdateSourceDto } from "./dto.js";
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

  /** D-004: saved mappings a workspace reuses. */
  @Get("workspaces/:ws/mapping-profiles")
  @Permission("source.manage")
  listProfiles(@Tenant() auth: AuthContext, @Query() query: Record<string, string>) {
    return this.sources.listProfiles(auth, query);
  }

  @Post("workspaces/:ws/mapping-profiles")
  @Permission("source.manage")
  createProfile(@Tenant() auth: AuthContext, @Body() body: CreateMappingProfileDto) {
    return this.sources.createProfile(auth, body);
  }

  @Post("workspaces/:ws/mapping-profiles/match")
  @Permission("source.manage")
  matchProfile(@Tenant() auth: AuthContext, @Body() body: MatchMappingProfileDto) {
    return this.sources.matchProfile(auth, body);
  }

  @Patch("mapping-profiles/:id")
  @Permission("source.manage")
  updateProfile(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateMappingProfileDto) {
    return this.sources.updateProfile(auth, id, body);
  }

  /** D-005: the workspace's words for columns and metrics. */
  @Get("workspaces/:ws/mapping-synonyms")
  @Permission("source.manage")
  listSynonyms(@Tenant() auth: AuthContext) {
    return this.sources.listSynonyms(auth);
  }

  @Post("workspaces/:ws/mapping-synonyms")
  @Permission("source.manage")
  createSynonym(@Tenant() auth: AuthContext, @Body() body: CreateMappingSynonymDto) {
    return this.sources.createSynonym(auth, body);
  }

  @Patch("mapping-synonyms/:id")
  @Permission("source.manage")
  updateSynonym(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateMappingSynonymDto) {
    return this.sources.updateSynonym(auth, id, body);
  }

  /** D-006: a mapping over a file's sample, as ingestion would read it; nothing is written. */
  @Post("workspaces/:ws/mapping-preview")
  @Permission("source.manage")
  preview(@Tenant() auth: AuthContext, @Body() body: MappingPreviewDto) {
    return this.sources.preview(auth, body);
  }

  /** S-6: the two routes that call OpenAI (via @budget/ai), so they get the stricter 10/min. */
  @Post("workspaces/:ws/mapping-suggestions")
  @Permission("source.manage")
  @RateLimit("ai-suggest", 10)
  suggestFromSample(@Tenant() auth: AuthContext, @Body() body: SuggestMappingSampleDto) {
    return this.sources.suggestFromSample(auth, body);
  }

  @Post("sources/:id/suggest-mapping")
  @Permission("source.manage")
  @RateLimit("ai-suggest", 10)
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
