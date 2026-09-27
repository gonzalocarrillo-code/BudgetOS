import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { createManualEntry, submitManualEntry, updateManualEntry } from "./commands/manual-entry.js";
import { CreateManualEntryDto, ListManualEntriesQueryDto, UpdateManualEntryDto } from "./dto.js";
import { getManualEntry, listManualEntries } from "./queries/manual-entry.js";

/**
 * Manual result entry (spec §26, §17). Entering results needs `envelope.edit_draft` (planners,
 * budget owners, admins), and submit checks the enterer's scope covers every row; reading needs
 * `envelope.read`. Approval goes through /approvals.
 */
@Controller()
export class ManualEntryController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("workspaces/:ws/manual-entries")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext, @Query() query: ListManualEntriesQueryDto) {
    return listManualEntries(this.prisma, auth, query);
  }

  @Post("workspaces/:ws/manual-entries")
  @Permission("envelope.edit_draft")
  create(@Tenant() auth: AuthContext, @Body() body: CreateManualEntryDto) {
    return createManualEntry(this.prisma, auth, body);
  }

  @Get("manual-entries/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return getManualEntry(this.prisma, auth, id);
  }

  @Patch("manual-entries/:id")
  @Permission("envelope.edit_draft")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateManualEntryDto) {
    return updateManualEntry(this.prisma, auth, id, body);
  }

  @Post("manual-entries/:id/submit")
  @Permission("envelope.edit_draft")
  submit(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return submitManualEntry(this.prisma, auth, id);
  }
}
