import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateRuleDto, ListAlertsQueryDto, UpdateAlertDto, UpdateRuleDto } from "./dto.js";
import { listAlerts, pacingView } from "./queries.js";
import { createRule, listRules, updateAlert, updateRule } from "./rules.js";

/** Pacing view, rules and alerts (spec §11, §17 `pacing`). Entity routes take the workspace from X-Workspace-Id. */
@Controller()
export class PacingController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/pacing")
  @Permission("envelope.read")
  pacing(@Tenant() auth: AuthContext, @Query("filter") filter?: string, @Query("period") period?: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return pacingView(this.prisma, auth, { filter, period, cursor, limit });
  }

  @Get("workspaces/:ws/rules")
  @Permission("workspace.member")
  rules(@Tenant() auth: AuthContext) {
    return listRules(this.prisma, auth);
  }

  @Post("workspaces/:ws/rules")
  @Permission("rule.manage")
  createRule(@Tenant() auth: AuthContext, @Body() body: CreateRuleDto) {
    return createRule(this.prisma, auth, body);
  }

  @Patch("rules/:id")
  @Permission("rule.manage")
  updateRule(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateRuleDto) {
    return updateRule(this.prisma, auth, id, body);
  }

  @Get("alerts")
  @Permission("envelope.read")
  alerts(@Tenant() auth: AuthContext, @Query() query: ListAlertsQueryDto) {
    return listAlerts(this.prisma, auth, query);
  }

  @Patch("alerts/:id")
  @Permission("envelope.edit_draft")
  updateAlert(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateAlertDto) {
    return updateAlert(this.prisma, auth, id, body);
  }
}
