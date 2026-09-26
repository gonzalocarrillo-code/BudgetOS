import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { CreateNamingTemplateDto, NamingPreviewDto, UpdateNamingTemplateDto } from "./dto.js";
import { createNamingTemplate, listNamingTemplates, previewNamingTemplate, updateNamingTemplate } from "./naming.js";

/** Naming templates (spec §24.4). Literal "preview" is registered before ":id" by Fastify's static-first matching. */
@Controller()
export class NamingController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/naming-templates")
  @Permission("workspace.member")
  list(@Tenant() auth: AuthContext) {
    return listNamingTemplates(this.prisma, auth);
  }

  @Post("workspaces/:ws/naming-templates")
  @Permission("registry.manage")
  create(@Tenant() auth: AuthContext, @Body() body: CreateNamingTemplateDto) {
    return createNamingTemplate(this.prisma, auth, body);
  }

  @Post("naming-templates/preview")
  @Permission("registry.manage")
  preview(@Tenant() auth: AuthContext, @Body() body: NamingPreviewDto) {
    return previewNamingTemplate(this.prisma, auth, body);
  }

  @Patch("naming-templates/:id")
  @Permission("registry.manage")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateNamingTemplateDto) {
    return updateNamingTemplate(this.prisma, auth, id, body);
  }
}
