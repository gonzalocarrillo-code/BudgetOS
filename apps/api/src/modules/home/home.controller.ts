import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CompleteTourDto, CreateWorkspaceDto, ListToursQueryDto, MarkNotificationsReadDto, UpdateTourDto } from "./dto.js";
import { getHome } from "./home.js";
import { myNotifications, readNotifications } from "./notifications.js";
import { completeTour, listTours, updateTour } from "../tours/tours.js";
import { createWorkspace, demoStatus, listTemplates, purgeDemo } from "../workspaces/workspaces.js";

/**
 * Home, tours and workspace templates (spec §27, §17 `home`). Entity routes take the workspace
 * from X-Workspace-Id; creating a workspace and listing templates are org-level (org admins).
 */
@Controller()
export class HomeController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("me/home")
  @Permission("workspace.member")
  home(@Tenant() auth: AuthContext) {
    return getHome(this.prisma, auth);
  }

  @Get("me/notifications")
  @Permission("workspace.member")
  notifications(@Tenant() auth: AuthContext) {
    return myNotifications(this.prisma, auth);
  }

  @Post("me/notifications/read")
  @HttpCode(200)
  @Permission("workspace.member")
  readNotifications(@Tenant() auth: AuthContext, @Body() body: MarkNotificationsReadDto) {
    return readNotifications(this.prisma, auth, body);
  }

  @Get("tours")
  @Permission("workspace.member")
  tours(@Tenant() auth: AuthContext, @Query() query: ListToursQueryDto) {
    return listTours(this.prisma, auth, query);
  }

  @Post("tours/:id/complete")
  @Permission("workspace.member")
  complete(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: CompleteTourDto) {
    return completeTour(this.prisma, auth, id, body);
  }

  /** A workspace's own tours (ORG-007): its admins edit them; the built-in defaults stay superadmin-owned. */
  @Patch("tours/:id")
  @Permission("user.manage")
  updateTour(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateTourDto) {
    return updateTour(this.prisma, auth, id, body);
  }

  @Get("workspace-templates")
  @Permission("org.admin")
  templates(@Tenant() auth: AuthContext) {
    return listTemplates(this.prisma, auth);
  }

  @Post("workspaces")
  @Permission("org.admin")
  createWorkspace(@Tenant() auth: AuthContext, @Body() body: CreateWorkspaceDto) {
    return createWorkspace(this.prisma, auth, body);
  }

  @Get("workspaces/:ws/demo-data")
  @Permission("workspace.member")
  demo(@Tenant() auth: AuthContext) {
    return demoStatus(this.prisma, auth);
  }

  @Post("workspaces/:ws/demo-data/purge")
  @Permission("user.manage")
  purge(@Tenant() auth: AuthContext) {
    return purgeDemo(this.prisma, auth);
  }
}
