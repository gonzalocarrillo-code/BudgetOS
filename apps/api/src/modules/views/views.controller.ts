import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { createSavedView, deleteSavedView, updateSavedView } from "./commands/views.js";
import { CreateSavedViewDto, ListSavedViewsQueryDto, UpdateSavedViewDto } from "./dto.js";
import { listSavedViews } from "./queries/list-views.js";

/** Saved views (spec §17 `views`). Entity routes take the workspace from X-Workspace-Id. */
@Controller()
export class ViewsController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/saved-views")
  @Permission("workspace.member")
  list(@Tenant() auth: AuthContext, @Query() query: ListSavedViewsQueryDto) {
    return listSavedViews(this.prisma, auth, query);
  }

  @Post("workspaces/:ws/saved-views")
  @Permission("workspace.member")
  create(@Tenant() auth: AuthContext, @Body() body: CreateSavedViewDto) {
    return createSavedView(this.prisma, auth, body);
  }

  @Patch("saved-views/:id")
  @Permission("workspace.member")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateSavedViewDto) {
    return updateSavedView(this.prisma, auth, id, body);
  }

  @Delete("saved-views/:id")
  @Permission("workspace.member")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return deleteSavedView(this.prisma, auth, id);
  }
}
