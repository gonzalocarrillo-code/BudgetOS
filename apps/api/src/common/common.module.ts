import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { LoggerModule } from "nestjs-pino";
import { ZodValidationPipe } from "nestjs-zod";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { MemoryRoleCache, ROLE_CACHE } from "./auth/role-cache.js";
import { assertAppRoleIsRestricted } from "./assert-app-role.js";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { HealthController } from "./health.controller.js";
import { pinoHttpOptions } from "./logging.js";
import { RateLimitInterceptor } from "./rate-limit.interceptor.js";
import { TenantInterceptor } from "./tenant.interceptor.js";

/**
 * W5-1 (AGENTS §4, audit M-3): JSON logs via pino, one request-scoped child logger per request.
 * `genReqId` is NOT set here — on Fastify it is never consulted (pino-http keeps whatever
 * `request.id` Fastify already assigned); main.ts's `FastifyAdapter({ genReqId })` is what makes
 * `X-Request-Id` (incoming, or a fresh uuid), `request.id` and this logger's `requestId` all agree.
 * `pinoHttpOptions` (logging.ts) is pulled out so a test can feed the exact same redact/key config
 * to its own capturable pino-http instance (request-id-logging.test.ts).
 */
const loggerModule = LoggerModule.forRoot({
  pinoHttp: pinoHttpOptions(),
  // So the "request completed" line itself (not just app logs during the request) also carries
  // workspaceId/actorId once TenantInterceptor resolves them via PinoLogger.assign.
  assignResponse: true,
});

/** Shared wiring: Prisma (application role), auth, tenant interceptor, zod pipe, error mapping. */
@Global()
@Module({
  imports: [loggerModule],
  controllers: [HealthController],
  providers: [
    {
      provide: PrismaClient,
      // No DATABASE_URL fallback (audit S-3): a missing or misnamed app secret in a revision must
      // fail loudly, not boot the API as the owner with RLS off. assertAppRoleIsRestricted is the
      // second line of defense for the same mistake by another route (a copy-pasted env var, a
      // secret aliased to the wrong value) — it refuses to start on a BYPASSRLS/superuser role.
      useFactory: async () => {
        const url = process.env["APP_DATABASE_URL"];
        if (url === undefined) {
          throw new Error("APP_DATABASE_URL is required");
        }
        const client = new PrismaClient({ datasources: { db: { url } } });
        await assertAppRoleIsRestricted(client);
        return client;
      },
    },
    JwtVerifier,
    AccessRepository,
    { provide: ROLE_CACHE, useFactory: () => new MemoryRoleCache() },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    // S-6: after TenantInterceptor in this array, so its "before" logic (which sets request.tenant)
    // runs first; see rate-limit.decorator.ts.
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Order matters (W5-1): Nest tries global filters most-recently-provided first, so the last
    // entry here is checked first. AllExceptionsFilter's bare @Catch() matches everything, so it
    // must come before DomainExceptionFilter's @Catch(DomainError) — otherwise it would shadow the
    // more specific filter and turn every DomainError into a generic 500 (proven by a test in
    // all-exceptions.filter.test.ts).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
  exports: [PrismaClient, AccessRepository, ROLE_CACHE],
})
export class CommonModule {}
