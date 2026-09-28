import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AccessRepository } from "../../common/auth/access.repository.js";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { getMe } from "./queries/get-me.js";
import { updateMe } from "./commands/update-me.js";

@Controller()
export class AuthController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(AccessRepository) private readonly access: AccessRepository,
  ) {}

  @Get("me")
  @Permission("authenticated")
  me(@Tenant() auth: AuthContext) {
    return getMe(this.prisma, this.access, auth);
  }

  @Patch("me")
  @Permission("authenticated")
  update(@Tenant() auth: AuthContext, @Body() body: unknown) {
    return updateMe(this.prisma, auth, body);
  }
}
