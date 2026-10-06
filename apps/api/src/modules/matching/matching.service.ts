import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createMatchRule, deleteMatchRule, rematchWorkspace } from "./commands/match-rules.js";
import { getMatchCoverage, listMatchRules } from "./queries/match-rules.js";

@Injectable()
export class MatchingService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  list(auth: AuthContext) {
    return listMatchRules(this.prisma, auth);
  }
  create(auth: AuthContext, body: unknown) {
    return createMatchRule(this.prisma, auth, body);
  }
  remove(auth: AuthContext, id: string) {
    return deleteMatchRule(this.prisma, auth, id);
  }
  rematch(auth: AuthContext) {
    return rematchWorkspace(this.prisma, auth);
  }
  coverage(auth: AuthContext, query: unknown) {
    return getMatchCoverage(this.prisma, auth, query);
  }
}
