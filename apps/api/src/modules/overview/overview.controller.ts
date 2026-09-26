import { Controller, Get, Inject, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { overview } from "./overview.js";

/** GET /workspaces/:ws/overview (T-033): the Overview dashboard in one call. */
@Controller()
export class OverviewController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/overview")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Query("period") period?: string) {
    return overview(this.prisma, auth, period);
  }
}
