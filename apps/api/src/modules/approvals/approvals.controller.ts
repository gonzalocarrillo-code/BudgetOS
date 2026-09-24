import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { ApprovalsService } from "./approvals.service.js";
import { CreatePolicyDto, DecideDto, ExternalEvidenceDto, UpdatePolicyDto, WithdrawDto } from "./dto.js";
import type { ListApprovalsQuery } from "./queries/approvals.js";

@Controller()
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get("approvals")
  @Permission("workspace.member")
  list(@Tenant() auth: AuthContext, @Query() query: ListApprovalsQuery) {
    return this.approvals.list(auth, query);
  }

  @Get("approvals/:id")
  @Permission("envelope.read")
  get(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.approvals.get(auth, id);
  }

  @Post("approvals/:id/decisions")
  @Permission("approval.decide")
  decide(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: DecideDto) {
    return this.approvals.decide(auth, id, body);
  }

  @Post("approvals/:id/external-evidence")
  @Permission("envelope.submit")
  externalEvidence(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: ExternalEvidenceDto) {
    return this.approvals.externalEvidence(auth, id, body);
  }

  @Post("approvals/:id/withdraw")
  @Permission("envelope.submit")
  withdraw(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: WithdrawDto) {
    return this.approvals.withdraw(auth, id, body);
  }

  @Get("workspaces/:ws/policies")
  @Permission("workspace.member")
  listPolicies(@Tenant() auth: AuthContext) {
    return this.approvals.listPolicies(auth);
  }

  @Post("workspaces/:ws/policies")
  @Permission("policy.manage")
  createPolicy(@Tenant() auth: AuthContext, @Body() body: CreatePolicyDto) {
    return this.approvals.createPolicy(auth, body);
  }

  @Patch("policies/:id")
  @Permission("policy.manage")
  updatePolicy(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdatePolicyDto) {
    return this.approvals.updatePolicy(auth, id, body);
  }
}
