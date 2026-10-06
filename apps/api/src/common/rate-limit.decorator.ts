import { SetMetadata } from "@nestjs/common";

/**
 * S-6: per-user request throttling for routes `@fastify/rate-limit` cannot key by user — Fastify's
 * plugin runs before Nest resolves the tenant (the user id only exists after `TenantInterceptor`
 * authenticates the caller), so these routes are throttled by `RateLimitInterceptor` instead,
 * which runs right after it in the same global interceptor chain (see common.module.ts) and reads
 * `request.tenant.user.id`.
 */
export interface RateLimitRule {
  /** A short name for the bucket (distinct routes with the same scope share one budget). */
  scope: string;
  max: number;
  windowMs: number;
}

export const RATE_LIMIT_KEY = "budget:rate-limit";

export const RateLimit = (scope: string, max: number, windowMs = 60_000) => SetMetadata(RATE_LIMIT_KEY, { scope, max, windowMs } satisfies RateLimitRule);
