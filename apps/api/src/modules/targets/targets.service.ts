import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { createTarget, createTargetDraft } from "./commands/create-target.js";
import { submitTarget } from "./commands/submit-target.js";
import { envelopeTargets, listTargets, targetVersions } from "./queries/targets.js";

@Injectable()
export class TargetsService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  list(auth: AuthContext, query: unknown) {
    return listTargets(this.prisma, auth, query);
  }
  create(auth: AuthContext, body: unknown) {
    return createTarget(this.prisma, auth, body);
  }
  draft(auth: AuthContext, id: string, body: unknown) {
    return createTargetDraft(this.prisma, auth, id, body);
  }
  submit(auth: AuthContext, id: string, body: unknown) {
    return submitTarget(this.prisma, auth, id, body);
  }
  versions(auth: AuthContext, id: string) {
    return targetVersions(this.prisma, auth, id);
  }
  forEnvelope(auth: AuthContext, envelopeId: string) {
    return envelopeTargets(this.prisma, auth, envelopeId);
  }
}
