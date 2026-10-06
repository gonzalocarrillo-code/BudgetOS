import { Controller, Get, Inject } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { DomainError } from "@budget/domain";
import { Permission } from "./permission.decorator.js";

/**
 * W5-1 (audit M-7): Cloud Run readiness — unlike `/health` (serve-web.ts, liveness: "is the process
 * up"), this touches the database so a revision that can't reach Postgres stops receiving traffic
 * instead of serving 500s. `@Permission("public")` is the same exemption `/health` gets by never
 * entering Nest's router at all; `setGlobalPrefix`'s `exclude` (configure-app.ts) keeps the path
 * unprefixed (`/ready`, not `/api/v1/ready`) to match it.
 */
@Controller()
export class HealthController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("ready")
  @Permission("public")
  async ready(): Promise<{ status: "ok" }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // Never the raw driver error to the client (AGENTS §4): a fixed DomainError, mapped to 503 by
      // DomainExceptionFilter's existing httpStatus table.
      throw new DomainError("UNAVAILABLE", "Database is not reachable");
    }
    return { status: "ok" };
  }
}
