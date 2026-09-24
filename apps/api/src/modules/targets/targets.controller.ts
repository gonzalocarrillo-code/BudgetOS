import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { SubmitVersionDto } from "../approvals/dto.js";
import { CreateTargetDraftDto, CreateTargetDto, ListTargetsQueryDto } from "./dto.js";
import { TargetsService } from "./targets.service.js";

/** Targets (spec §10, §17). Entity routes take the workspace from X-Workspace-Id; RLS does the rest. */
@Controller()
export class TargetsController {
  constructor(@Inject(TargetsService) private readonly targets: TargetsService) {}

  @Get("workspaces/:ws/targets")
  @Permission("target.read")
  list(@Tenant() auth: AuthContext, @Query() query: ListTargetsQueryDto) {
    return this.targets.list(auth, query);
  }

  @Post("workspaces/:ws/targets")
  @Permission("target.edit_draft")
  create(@Tenant() auth: AuthContext, @Body() body: CreateTargetDto) {
    return this.targets.create(auth, body);
  }

  @Patch("targets/:id/draft")
  @Permission("target.edit_draft")
  draft(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: CreateTargetDraftDto) {
    return this.targets.draft(auth, id, body);
  }

  @Post("targets/:id/submit")
  @Permission("target.submit")
  submit(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: SubmitVersionDto) {
    return this.targets.submit(auth, id, body);
  }

  @Get("targets/:id/versions")
  @Permission("target.read")
  versions(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.targets.versions(auth, id);
  }

  @Get("envelopes/:id/targets")
  @Permission("target.read")
  forEnvelope(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.targets.forEnvelope(auth, id);
  }
}
