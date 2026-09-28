import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AccessRepository } from "../../common/auth/access.repository.js";
import { ROLE_CACHE, type RoleCache } from "../../common/auth/role-cache.js";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { getSlackSettings, handleCommand, handleInteraction, sendSlackTest, updateSlackSettings } from "./slack.service.js";

/** Slack settings, and the endpoints Slack itself calls (signed, no JWT; ADR-046). */
@Controller()
export class SlackController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(AccessRepository) private readonly access: AccessRepository,
    @Inject(ROLE_CACHE) private readonly cache: RoleCache,
  ) {}

  @Get("workspaces/:ws/integrations/slack")
  @Permission("workspace.member")
  settings(@Tenant() auth: AuthContext) {
    return getSlackSettings(this.prisma, auth);
  }

  @Patch("workspaces/:ws/integrations/slack")
  @Permission("user.manage")
  update(@Tenant() auth: AuthContext, @Body() body: unknown) {
    return updateSlackSettings(this.prisma, auth, body);
  }

  @Post("workspaces/:ws/integrations/slack/test")
  @Permission("user.manage")
  test(@Tenant() auth: AuthContext, @Body() body: unknown) {
    return sendSlackTest(this.prisma, auth, body);
  }

  @Post("slack/interactions")
  @HttpCode(200)
  @Permission("slack.signed")
  interactions(@Body() body: unknown) {
    return handleInteraction(this.prisma, { access: this.access, cache: this.cache }, body);
  }

  @Post("slack/commands")
  @HttpCode(200)
  @Permission("slack.signed")
  commands(@Body() body: unknown) {
    return handleCommand(this.prisma, { access: this.access, cache: this.cache }, body);
  }
}
