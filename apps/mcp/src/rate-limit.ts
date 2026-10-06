import { DomainError } from "@budget/domain";
import { createClient } from "@redis/client";

/**
 * 120 tool calls per minute per user (spec §16). A fixed one-minute window per user: INCR, and
 * EXPIRE on the window's first call. Redis in deployed environments so every instance shares the
 * count; memory when REDIS_URL is unset (one local process).
 *
 * S-17: `export_csv` writes one GCS object per call, so it gets its own, stricter window
 * (`EXPORT_CALLS_PER_MINUTE`), tracked under its own key (`scope`) and independent of the general
 * 120/min budget — calling `take(userId, "export_csv")` does not spend a unit of the default scope.
 */
export const CALLS_PER_MINUTE = 120;
export const EXPORT_CALLS_PER_MINUTE = 10;

export interface RateLimiter {
  take(userId: string, scope?: string): Promise<void>;
}

const limitFor = (scope: string) => (scope === "export_csv" ? EXPORT_CALLS_PER_MINUTE : CALLS_PER_MINUTE);
const windowKey = (userId: string, scope: string, now: number) => `mcp:rl:${scope}:${userId}:${Math.floor(now / 60_000)}`;
const refuse = (limit: number) => new DomainError("RATE_LIMITED", `More than ${limit} MCP calls in a minute; retry shortly`, { limit });

export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly limit = CALLS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}
  async take(userId: string, scope = "default"): Promise<void> {
    const limit = scope === "default" ? this.limit : limitFor(scope);
    const key = windowKey(userId, scope, this.now());
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (this.counts.size > 10_000) this.counts.clear();
    if (n > limit) throw refuse(limit);
  }
}

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: ReturnType<typeof createClient>;
  constructor(
    url: string,
    private readonly limit = CALLS_PER_MINUTE,
  ) {
    this.redis = createClient({ url });
  }
  async connect(): Promise<this> {
    await this.redis.connect();
    return this;
  }
  async take(userId: string, scope = "default"): Promise<void> {
    const limit = scope === "default" ? this.limit : limitFor(scope);
    const key = windowKey(userId, scope, Date.now());
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > limit) throw refuse(limit);
  }
}

export async function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RateLimiter> {
  const url = env["REDIS_URL"];
  if (!url) return new MemoryRateLimiter();
  return new RedisRateLimiter(url).connect();
}
