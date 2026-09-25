import { DomainError } from "@budget/domain";
import { createClient } from "@redis/client";

/**
 * 120 tool calls per minute per user (spec §16). A fixed one-minute window per user: INCR, and
 * EXPIRE on the window's first call. Redis in deployed environments so every instance shares the
 * count; memory when REDIS_URL is unset (one local process).
 */
export const CALLS_PER_MINUTE = 120;

export interface RateLimiter {
  take(userId: string): Promise<void>;
}

const windowKey = (userId: string, now: number) => `mcp:rl:${userId}:${Math.floor(now / 60_000)}`;
const refuse = (limit: number) => new DomainError("RATE_LIMITED", `More than ${limit} MCP calls in a minute; retry shortly`, { limit });

export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly limit = CALLS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}
  async take(userId: string): Promise<void> {
    const key = windowKey(userId, this.now());
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (this.counts.size > 10_000) this.counts.clear();
    if (n > this.limit) throw refuse(this.limit);
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
  async take(userId: string): Promise<void> {
    const key = windowKey(userId, Date.now());
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > this.limit) throw refuse(this.limit);
  }
}

export async function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RateLimiter> {
  const url = env["REDIS_URL"];
  if (!url) return new MemoryRateLimiter();
  return new RedisRateLimiter(url).connect();
}
