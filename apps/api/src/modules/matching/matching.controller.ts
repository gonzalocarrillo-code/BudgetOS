import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateMatchRuleDto, CreateNamingConventionDto, NamingConventionPreviewDto } from "./dto.js";
import { MatchingService } from "./matching.service.js";

/**
 * EX-1 (ADR-0085): match rules and match coverage. Writing a rule needs envelope.edit_draft in the
 * target budget's scope (checked in the service); coverage and the workspace re-match are data
 * operations (source.manage), like the unmatched queue. EX-5 (ADR-0090): naming conventions decide
 * where spend lands across budgets, so writing or previewing one is a data operation too.
 */
@Controller()
export class MatchingController {
  constructor(@Inject(MatchingService) private readonly matching: MatchingService) {}

  @Get("workspaces/:ws/match-rules")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext) {
    return this.matching.list(auth);
  }

  @Post("workspaces/:ws/match-rules")
  @Permission("envelope.edit_draft")
  create(@Tenant() auth: AuthContext, @Body() body: CreateMatchRuleDto) {
    return this.matching.create(auth, body);
  }

  @Post("workspaces/:ws/match-rules/rematch")
  @Permission("source.manage")
  rematch(@Tenant() auth: AuthContext) {
    return this.matching.rematch(auth);
  }

  @Delete("match-rules/:id")
  @Permission("envelope.edit_draft")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.matching.remove(auth, id);
  }

  @Get("workspaces/:ws/match-coverage")
  @Permission("source.manage")
  coverage(@Tenant() auth: AuthContext, @Query() query: Record<string, string>) {
    return this.matching.coverage(auth, query);
  }

  @Post("workspaces/:ws/naming-conventions")
  @Permission("source.manage")
  createConvention(@Tenant() auth: AuthContext, @Body() body: CreateNamingConventionDto) {
    return this.matching.createConvention(auth, body);
  }

  @Post("workspaces/:ws/naming-conventions/preview")
  @Permission("source.manage")
  previewConvention(@Tenant() auth: AuthContext, @Body() body: NamingConventionPreviewDto) {
    return this.matching.previewConvention(auth, body);
  }

  @Delete("naming-conventions/:id")
  @Permission("source.manage")
  removeConvention(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.matching.removeConvention(auth, id);
  }
}
