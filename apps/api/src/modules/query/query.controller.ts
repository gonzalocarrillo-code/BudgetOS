import { Body, Controller, Inject, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { QueryRequestDto } from "./dto.js";
import { runQuery } from "./queries/run-query.js";

/** POST /workspaces/:ws/query (spec §6, §17 `query`): the planner, cut to the caller's read scope. */
@Controller()
export class QueryController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Post("workspaces/:ws/query")
  @Permission("envelope.read")
  query(@Tenant() auth: AuthContext, @Body() body: QueryRequestDto) {
    return runQuery(this.prisma, auth, body);
  }
}
