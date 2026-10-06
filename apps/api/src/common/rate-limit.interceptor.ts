import { DomainError } from "@budget/domain";
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RATE_LIMIT_KEY, type RateLimitRule } from "./rate-limit.decorator.js";
import type { TenantRequest } from "./tenant.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * S-6: a global interceptor (registered in common.module.ts, right after `TenantInterceptor`, so
 * `request.tenant` is already set — see rate-limit.decorator.ts) that enforces `@RateLimit` on the
 * routes that declare it (search/suggest, the two OpenAI-backed source routes) and does nothing on
 * every other route. In-memory and per-instance, like the MCP server's own limiter
 * (apps/mcp/src/rate-limit.ts) — the same "good enough until Memorystore" tradeoff (D-2).
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler["handle"]> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (rule) this.take(context, rule);
    return next.handle();
  }

  private take(context: ExecutionContext, rule: RateLimitRule): void {
    const request = context.switchToHttp().getRequest<TenantRequest & { ip?: string }>();
    const key = request.tenant?.user.id ?? request.ip ?? "unknown";
    const bucketKey = `${rule.scope}:${key}`;
    const now = Date.now();
    if (this.buckets.size > 50_000) this.buckets.clear();
    const existing = this.buckets.get(bucketKey);
    const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + rule.windowMs };
    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);
    if (bucket.count > rule.max) {
      throw new DomainError("RATE_LIMITED", `More than ${rule.max} requests in ${Math.round(rule.windowMs / 1000)}s; retry shortly`, { limit: rule.max, scope: rule.scope });
    }
  }
}
