import { Controller, Get, Inject, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { search, suggest } from "./search.js";

/** Search (spec §17 `search`). RLS limits to the workspace; dimension scopes are applied in SQL. */
@Controller()
export class SearchController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/search")
  @Permission("workspace.member")
  search(@Tenant() auth: AuthContext, @Query("q") q?: string, @Query("types") types?: string, @Query("limit") limit?: string) {
    return search(this.prisma, auth, { q, types, limit });
  }

  @Get("workspaces/:ws/search/suggest")
  @Permission("workspace.member")
  suggest(@Tenant() auth: AuthContext, @Query("prefix") prefix?: string) {
    return suggest(this.prisma, auth, prefix);
  }
}
