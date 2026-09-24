import { Controller, Get, Inject } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AccessRepository } from "../../common/auth/access.repository.js";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { getMe } from "./queries/get-me.js";

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
}
