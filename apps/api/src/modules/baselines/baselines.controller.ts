import { BaselineReportQuery, CreateBaselineInput, UpdateBaselineInput } from "@budget/domain";
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createZodDto } from "nestjs-zod";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { saveBaseline, updateBaseline } from "./commands/baselines.js";
import { baselineReport, listBaselines } from "./queries/baselines.js";

class CreateBaselineDto extends createZodDto(CreateBaselineInput) {}
class UpdateBaselineDto extends createZodDto(UpdateBaselineInput) {}
class BaselineReportQueryDto extends createZodDto(BaselineReportQuery) {}

/** Snapshots (Phase E, ADR-053). Saving checks its scope in the service: see assertMayManage. */
@Controller()
export class BaselinesController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/baselines")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext, @Query() query: Record<string, string>) {
    return listBaselines(this.prisma, auth, query);
  }

  @Post("workspaces/:ws/baselines")
  @Permission("workspace.member")
  save(@Tenant() auth: AuthContext, @Body() body: CreateBaselineDto) {
    return saveBaseline(this.prisma, auth, body);
  }

  @Patch("baselines/:id")
  @Permission("workspace.member")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateBaselineDto) {
    return updateBaseline(this.prisma, auth, id, body);
  }

  @Get("baselines/:id/report")
  @Permission("envelope.read")
  report(@Tenant() auth: AuthContext, @Param("id") id: string, @Query() query: BaselineReportQueryDto) {
    return baselineReport(this.prisma, auth, id, query);
  }
}
