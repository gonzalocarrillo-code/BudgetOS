import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { getWorkspaceGeneral, updateWorkspaceGeneral } from "./commands/workspace-general.js";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { AdminService } from "./admin.service.js";
import { AddPersonDto, AssignRoleDto, GroupsSyncDto } from "./dto.js";

@Controller()
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
  ) {}

  @Get("workspaces/:ws/general")
  @Permission("workspace.member")
  general(@Tenant() auth: AuthContext) {
    return getWorkspaceGeneral(this.prisma, auth);
  }

  @Patch("workspaces/:ws/general")
  @Permission("user.manage")
  renameWorkspace(@Tenant() auth: AuthContext, @Body() body: unknown) {
    return updateWorkspaceGeneral(this.prisma, auth, body);
  }

  @Get("workspaces/:ws/roles")
  @Permission("user.manage")
  listRoles(@Tenant() auth: AuthContext) {
    return this.admin.listRoles(auth);
  }

  @Post("workspaces/:ws/roles")
  @Permission("user.manage")
  assignRole(@Tenant() auth: AuthContext, @Body() body: AssignRoleDto) {
    return this.admin.assignRole(auth, body);
  }

  @Delete("roles/:id")
  @Permission("user.manage")
  revokeRole(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.admin.revokeRole(auth, id);
  }

  /** The Roles page: the org's people and groups with their roles here. */
  @Get("workspaces/:ws/members")
  @Permission("user.manage")
  people(@Tenant() auth: AuthContext) {
    return this.admin.people(auth);
  }

  /** Add a person to this workspace by email, with a role here (ORG-005); they sign in with Google later. */
  @Post("workspaces/:ws/members")
  @Permission("user.manage")
  addPerson(@Tenant() auth: AuthContext, @Body() body: AddPersonDto) {
    return this.admin.addPerson(auth, body);
  }

  /** Google Groups are org-wide: only a superadmin syncs them (ORG-005). */
  @Post("workspaces/:ws/groups/sync")
  @Permission("org.admin")
  syncGroups(@Tenant() auth: AuthContext, @Body() body: GroupsSyncDto) {
    return this.admin.syncGroups(auth, body);
  }
}
