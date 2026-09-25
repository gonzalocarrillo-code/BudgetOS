import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateExportDto } from "./dto.js";
import { ExportsService } from "./exports.service.js";

/** CSV / XLSX exports (plan §6.2, spec §17 `exports`). Routes take the workspace from X-Workspace-Id. */
@Controller()
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exports: ExportsService) {}

  @Post("exports")
  @Permission("export.run")
  create(@Tenant() auth: AuthContext, @Body() body: CreateExportDto) {
    return this.exports.create(auth, body);
  }

  @Get("exports/:jobId")
  @Permission("export.run")
  get(@Tenant() auth: AuthContext, @Param("jobId") jobId: string) {
    return this.exports.get(auth, jobId);
  }
}
