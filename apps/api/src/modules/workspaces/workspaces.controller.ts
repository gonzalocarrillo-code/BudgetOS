import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission, WorkspaceLifecycle } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { DeleteWorkspaceDto, UpdateOrgPersonDto, UpdateWorkspaceStatusDto } from "./dto.js";
import { listOrgPeople, updateOrgPerson } from "./org-people.js";
import { ROLE_CACHE, type RoleCache } from "../../common/auth/role-cache.js";
import { deleteWorkspace, listWorkspaces, setWorkspaceStatus, undeleteWorkspace } from "./lifecycle.js";

/** The org console's workspace routes (ADR-052): superadmins only. */
@Controller()
export class WorkspacesController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(ROLE_CACHE) private readonly cache: RoleCache,
  ) {}

  @Get("org/people")
  @Permission("org.admin")
  people(@Tenant() auth: AuthContext) {
    return listOrgPeople(this.prisma, auth);
  }

  @Patch("org/people/:id")
  @Permission("org.admin")
  async updatePerson(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateOrgPersonDto) {
    const out = await updateOrgPerson(this.prisma, auth, id, body);
    this.cache.clear();
    return out;
  }

  @Get("workspaces")
  @Permission("org.admin")
  list(@Tenant() auth: AuthContext) {
    return listWorkspaces(this.prisma, auth);
  }

  @Patch("workspaces/:ws")
  @Permission("org.admin")
  @WorkspaceLifecycle()
  async setStatus(@Tenant() auth: AuthContext, @Body() body: UpdateWorkspaceStatusDto) {
    const out = await setWorkspaceStatus(this.prisma, auth, body);
    this.cache.clear();
    return out;
  }

  @Delete("workspaces/:ws")
  @Permission("org.admin")
  @WorkspaceLifecycle()
  remove(@Tenant() auth: AuthContext, @Body() body: DeleteWorkspaceDto) {
    return deleteWorkspace(this.prisma, auth, body);
  }

  @Post("workspaces/:ws/undelete")
  @HttpCode(200)
  @Permission("org.admin")
  @WorkspaceLifecycle()
  undelete(@Tenant() auth: AuthContext) {
    return undeleteWorkspace(this.prisma, auth);
  }
}
