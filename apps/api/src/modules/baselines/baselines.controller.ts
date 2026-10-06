import { BaselineReportQuery, BaselineRowsQuery, CreateBaselineInput, UpdateBaselineInput } from "@budget/domain";
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createZodDto } from "nestjs-zod";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { saveBaseline, updateBaseline } from "./commands/baselines.js";
import { baselineCsv, baselineReport, baselineRows, getBaseline, listBaselines } from "./queries/baselines.js";

class CreateBaselineDto extends createZodDto(CreateBaselineInput) {}
class UpdateBaselineDto extends createZodDto(UpdateBaselineInput) {}
class BaselineReportQueryDto extends createZodDto(BaselineReportQuery) {}
class BaselineRowsQueryDto extends createZodDto(BaselineRowsQuery) {}

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
  @Permission("baseline.save")
  save(@Tenant() auth: AuthContext, @Body() body: CreateBaselineDto) {
    return saveBaseline(this.prisma, auth, body);
  }

  @Patch("baselines/:id")
  @Permission("baseline.save")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateBaselineDto) {
    return updateBaseline(this.prisma, auth, id, body);
  }

  @Get("baselines/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return getBaseline(this.prisma, auth, id);
  }

  /** The Snapshots page: the frozen rows as the tree they were saved in. */
  @Get("baselines/:id/rows")
  @Permission("envelope.read")
  rows(@Tenant() auth: AuthContext, @Param("id") id: string, @Query() query: BaselineRowsQueryDto) {
    return baselineRows(this.prisma, auth, id, query);
  }

  /** The snapshot as a file, so it can be kept or opened anywhere. */
  @Get("baselines/:id/export.csv")
  @Permission("envelope.read")
  async csv(@Tenant() auth: AuthContext, @Param("id") id: string, @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown }) {
    const { filename, csv } = await baselineCsv(this.prisma, auth, id);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return csv;
  }

  @Get("baselines/:id/report")
  @Permission("envelope.read")
  report(@Tenant() auth: AuthContext, @Param("id") id: string, @Query() query: BaselineReportQueryDto) {
    return baselineReport(this.prisma, auth, id, query);
  }
}
