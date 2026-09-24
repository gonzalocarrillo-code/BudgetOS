import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { SubmitVersionDto, WithdrawDto } from "../approvals/dto.js";
import { CreateDraftVersionDto, CreateEnvelopeDto, RestoreVersionDto, UpdateEnvelopeDto, UpdatePhasingDto } from "./dto.js";
import { EnvelopesService } from "./envelopes.service.js";

@Controller()
export class EnvelopesController {
  constructor(@Inject(EnvelopesService) private readonly envelopes: EnvelopesService) {}

  @Post("workspaces/:ws/envelopes")
  @Permission("envelope.create")
  create(@Tenant() auth: AuthContext, @Body() body: CreateEnvelopeDto) {
    return this.envelopes.create(auth, body);
  }

  @Get("envelopes/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.envelopes.get(auth, id);
  }

  @Get("envelopes/:id/versions")
  @Permission("envelope.read")
  versions(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.envelopes.versions(auth, id);
  }

  @Patch("envelopes/:id")
  @Permission("envelope.edit_draft")
  update(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateEnvelopeDto) {
    return this.envelopes.update(auth, id, body);
  }

  @Patch("envelopes/:id/draft")
  @Permission("envelope.edit_draft")
  draft(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: CreateDraftVersionDto) {
    return this.envelopes.draft(auth, id, body);
  }

  @Patch("envelopes/:id/phasing")
  @Permission("envelope.edit_draft")
  phasing(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdatePhasingDto) {
    return this.envelopes.phasing(auth, id, body);
  }

  @Post("envelopes/:id/restore/:versionId")
  @Permission("envelope.edit_draft")
  restore(@Tenant() auth: AuthContext, @Param("id") id: string, @Param("versionId") versionId: string, @Body() body: RestoreVersionDto) {
    return this.envelopes.restore(auth, id, versionId, body);
  }

  @Post("envelopes/:id/submit")
  @Permission("envelope.submit")
  submit(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: SubmitVersionDto) {
    return this.envelopes.submit(auth, id, body);
  }

  @Post("envelopes/:id/withdraw")
  @Permission("envelope.submit")
  withdraw(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: WithdrawDto) {
    return this.envelopes.withdraw(auth, id, body);
  }
}
