import { Body, Controller, Get, Inject, Post, Query, Res } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { QueryRequestDto, TimelineQueryDto } from "./dto.js";
import { runQuery } from "./queries/run-query.js";
import { timelineQuery } from "./queries/timeline.query.js";

/** POST /workspaces/:ws/query (spec §6, §17 `query`): the planner, cut to the caller's read scope. */
@Controller()
export class QueryController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Post("workspaces/:ws/query")
  @Permission("envelope.read")
  query(@Tenant() auth: AuthContext, @Body() body: QueryRequestDto) {
    return runQuery(this.prisma, auth, body);
  }

  /** GET /workspaces/:ws/timeline (spec §23.1): the Gantt's bars on the fiscal calendar; X-Data-Version as on /query. */
  @Get("workspaces/:ws/timeline")
  @Permission("envelope.read")
  async timeline(@Tenant() auth: AuthContext, @Query() query: TimelineQueryDto, @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown }) {
    const res = await timelineQuery(this.prisma, auth, query);
    reply.header("x-data-version", res.dataVersion);
    return res;
  }
}
