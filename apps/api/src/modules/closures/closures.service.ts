import { Inject, Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../common/tenant.js";
import { closePeriod } from "./commands/close-period.js";
import { restateClosure } from "./commands/restate.js";
import { closureReport, listClosures } from "./queries/closures.js";
import { CLOSURE_SINK, type ClosureSink } from "./sink.js";

@Injectable()
export class ClosuresService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(CLOSURE_SINK) private readonly sink: ClosureSink | null,
  ) {}

  list(auth: AuthContext) {
    return listClosures(this.prisma, auth);
  }
  close(auth: AuthContext, body: unknown) {
    return closePeriod(this.prisma, this.sink, auth, body);
  }
  restate(auth: AuthContext, id: string, body: unknown) {
    return restateClosure(this.prisma, auth, id, body);
  }
  report(auth: AuthContext, id: string) {
    return closureReport(this.prisma, auth, id);
  }
}
