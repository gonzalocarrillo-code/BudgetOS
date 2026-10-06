import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { concludeExperiment, createExperiment, deleteExperiment, linkEnvelope, transitionExperiment, updateExperiment } from "./commands/experiments.js";
import { ConcludeExperimentDto, CreateExperimentDto, ExperimentScopeValuesQueryDto, LinkEnvelopeDto, ListExperimentsQueryDto, UpdateExperimentDto } from "./dto.js";
import { getExperiment, listExperiments, listScopeValues } from "./queries/experiments.js";

/**
 * Experiments (spec §25, §17 `experiments`). Reads need envelope.read; writes need
 * envelope.edit_draft (a test is a budget change in the making), and linking also checks the
 * envelope's scope. Entity routes take the workspace from X-Workspace-Id. EX-2: DELETE is permanent
 * and, beyond envelope.edit_draft, needs the experiment's owner or a workspace admin (checked in the
 * command); scope-values lists a fact dimension's values (campaigns) with spend in a window.
 */
@Controller()
export class ExperimentsController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/experiments")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext, @Query() query: ListExperimentsQueryDto) {
    return listExperiments(this.prisma, auth, query);
  }

  @Post("workspaces/:ws/experiments")
  @Permission("envelope.edit_draft")
  create(@Tenant() auth: AuthContext, @Body() body: CreateExperimentDto) {
    return createExperiment(this.prisma, auth, body);
  }

  @Get("workspaces/:ws/experiments/scope-values")
  @Permission("envelope.read")
  scopeValues(@Tenant() auth: AuthContext, @Query() query: ExperimentScopeValuesQueryDto) {
    return listScopeValues(this.prisma, auth, query);
  }

  @Get("experiments/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return getExperiment(this.prisma, auth, id);
  }

  @Patch("experiments/:id")
  @Permission("envelope.edit_draft")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateExperimentDto) {
    return updateExperiment(this.prisma, auth, id, body);
  }

  @Delete("experiments/:id")
  @Permission("envelope.edit_draft")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return deleteExperiment(this.prisma, auth, id);
  }

  @Post("experiments/:id/link")
  @Permission("envelope.edit_draft")
  link(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: LinkEnvelopeDto) {
    return linkEnvelope(this.prisma, auth, id, body);
  }

  @Post("experiments/:id/start")
  @Permission("envelope.edit_draft")
  start(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return transitionExperiment(this.prisma, auth, id, "start");
  }

  @Post("experiments/:id/evaluate")
  @Permission("envelope.edit_draft")
  evaluate(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return transitionExperiment(this.prisma, auth, id, "evaluate");
  }

  @Post("experiments/:id/abandon")
  @Permission("envelope.edit_draft")
  abandon(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return transitionExperiment(this.prisma, auth, id, "abandon");
  }

  @Post("experiments/:id/conclude")
  @Permission("envelope.edit_draft")
  conclude(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: ConcludeExperimentDto) {
    return concludeExperiment(this.prisma, auth, id, body);
  }
}
