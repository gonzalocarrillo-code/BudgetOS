import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { decide } from "./commands/decide.js";
import { recordExternalEvidence } from "./commands/external-evidence.js";
import { createPolicy, updatePolicy } from "./commands/policies.js";
import { withdrawRequest } from "./commands/withdraw.js";
import { getApproval, listApprovals, listPolicies, type ListApprovalsQuery } from "./queries/approvals.js";

@Injectable()
export class ApprovalsService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  list(auth: AuthContext, query: ListApprovalsQuery) {
    return listApprovals(this.prisma, auth, query);
  }
  get(auth: AuthContext, id: string) {
    return getApproval(this.prisma, auth, id);
  }
  async decide(auth: AuthContext, id: string, body: unknown) {
    await decide(this.prisma, auth, id, body);
    return getApproval(this.prisma, auth, id);
  }
  async externalEvidence(auth: AuthContext, id: string, body: unknown) {
    const out = await recordExternalEvidence(this.prisma, auth, id, body);
    return { ...(await getApproval(this.prisma, auth, id)), counted: out.counted };
  }
  async withdraw(auth: AuthContext, id: string, body: unknown) {
    await withdrawRequest(this.prisma, auth, id, body);
    return getApproval(this.prisma, auth, id);
  }
  listPolicies(auth: AuthContext) {
    return listPolicies(this.prisma, auth);
  }
  createPolicy(auth: AuthContext, body: unknown) {
    return createPolicy(this.prisma, auth, body);
  }
  updatePolicy(auth: AuthContext, id: string, body: unknown) {
    return updatePolicy(this.prisma, auth, id, body);
  }
}
