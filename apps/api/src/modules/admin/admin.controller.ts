import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { AdminService } from "./admin.service.js";
import { AssignRoleDto, GroupsSyncDto } from "./dto.js";

@Controller()
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

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

  @Post("workspaces/:ws/groups/sync")
  @Permission("user.manage")
  syncGroups(@Tenant() auth: AuthContext, @Body() body: GroupsSyncDto) {
    return this.admin.syncGroups(auth, body);
  }
}
