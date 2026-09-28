import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreatePeriodDto, GeneratePeriodsDto, UpdatePeriodDto } from "./dto.js";
import { createPeriod, deletePeriod, generatePeriods, getFiscalYearStart, listPeriods, setFiscalYearStart, updatePeriod } from "./periods.js";

/** The fiscal calendar (ADR-041): periods and the fiscal year start. Entity routes take the workspace from X-Workspace-Id. */
@Controller()
export class PeriodsController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/periods")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext) {
    return listPeriods(this.prisma, auth);
  }

  @Post("workspaces/:ws/periods")
  @Permission("registry.manage")
  create(@Tenant() auth: AuthContext, @Body() body: CreatePeriodDto) {
    return createPeriod(this.prisma, auth, body);
  }

  @Post("workspaces/:ws/periods/generate")
  @Permission("registry.manage")
  generate(@Tenant() auth: AuthContext, @Body() body: GeneratePeriodsDto) {
    return generatePeriods(this.prisma, auth, body);
  }

  @Get("workspaces/:ws/fiscal-year")
  @Permission("envelope.read")
  getFiscalYear(@Tenant() auth: AuthContext) {
    return getFiscalYearStart(this.prisma, auth);
  }

  @Patch("workspaces/:ws/fiscal-year")
  @Permission("registry.manage")
  fiscalYear(@Tenant() auth: AuthContext, @Body() body: Record<string, unknown>) {
    return setFiscalYearStart(this.prisma, auth, body);
  }

  @Patch("periods/:id")
  @Permission("registry.manage")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdatePeriodDto) {
    return updatePeriod(this.prisma, auth, id, body);
  }

  @Delete("periods/:id")
  @Permission("registry.manage")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return deletePeriod(this.prisma, auth, id);
  }
}
