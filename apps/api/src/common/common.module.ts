import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { ZodValidationPipe } from "nestjs-zod";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { MemoryRoleCache, ROLE_CACHE } from "./auth/role-cache.js";
import { assertAppRoleIsRestricted } from "./assert-app-role.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { RateLimitInterceptor } from "./rate-limit.interceptor.js";
import { TenantInterceptor } from "./tenant.interceptor.js";

/** Shared wiring: Prisma (application role), auth, tenant interceptor, zod pipe, error mapping. */
@Global()
@Module({
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
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
  exports: [PrismaClient, AccessRepository, ROLE_CACHE],
})
export class CommonModule {}
