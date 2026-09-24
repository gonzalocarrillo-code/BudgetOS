import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ROLE_CACHE, type RoleCache } from "../../common/auth/role-cache.js";
import type { AuthContext } from "../../common/tenant.js";
import { assignRole } from "./commands/assign-role.js";
import { revokeRole } from "./commands/revoke-role.js";
import { syncGroups } from "./commands/sync-groups.js";
import { listRoles } from "./queries/list-roles.js";

/** Role and group changes clear the role cache after commit so they apply on the next request. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(ROLE_CACHE) private readonly cache: RoleCache,
  ) {}

  listRoles(auth: AuthContext) {
    return listRoles(this.prisma, auth);
  }

  async assignRole(auth: AuthContext, body: unknown) {
    const row = await assignRole(this.prisma, auth, body);
    this.cache.clear();
    return row;
  }

  async revokeRole(auth: AuthContext, id: string) {
    const out = await revokeRole(this.prisma, auth, id);
    this.cache.clear();
    return out;
  }

  async syncGroups(auth: AuthContext, body: unknown) {
    const out = await syncGroups(this.prisma, auth, body);
    this.cache.clear();
    return out;
  }
}
