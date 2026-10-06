import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { ZodValidationPipe } from "nestjs-zod";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { MemoryRoleCache, ROLE_CACHE } from "./auth/role-cache.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { RateLimitInterceptor } from "./rate-limit.interceptor.js";
import { TenantInterceptor } from "./tenant.interceptor.js";

/** Shared wiring: Prisma (application role), auth, tenant interceptor, zod pipe, error mapping. */
@Global()
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: () => {
        const url = process.env["APP_DATABASE_URL"] ?? process.env["DATABASE_URL"];
        if (url === undefined) {
          throw new Error("APP_DATABASE_URL is required");
        }
        return new PrismaClient({ datasources: { db: { url } } });
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
