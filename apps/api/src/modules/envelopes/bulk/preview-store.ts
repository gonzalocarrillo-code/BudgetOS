import { createClient } from "@redis/client";

/** Where bulk previews live between preview and commit (spec §7.4: Redis, key `bulk:<previewId>`, 30 min). */
export interface PreviewStore {
  put(id: string, value: string, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<string | null>;
  delete(id: string): Promise<void>;
}

export const PREVIEW_STORE = Symbol("PREVIEW_STORE");
export const PREVIEW_TTL_SECONDS = 30 * 60;
const key = (id: string) => `bulk:${id}`;

/** Single-process fallback for local dev and tests without Redis. Honors the TTL. */
export class MemoryPreviewStore implements PreviewStore {
  private readonly items = new Map<string, { value: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async put(id: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key(id), { value, expires: this.now() + ttlSeconds * 1000 });
  }
  async get(id: string): Promise<string | null> {
    const hit = this.items.get(key(id));
    if (!hit) return null;
    if (hit.expires <= this.now()) {
      this.items.delete(key(id));
      return null;
    }
    return hit.value;
  }
  async delete(id: string): Promise<void> {
    this.items.delete(key(id));
  }
}

export class RedisPreviewStore implements PreviewStore {
  private readonly client: ReturnType<typeof createClient>;
  private ready: Promise<unknown> | null = null;
  constructor(url: string) {
    this.client = createClient({ url });
  }
  private async c() {
    this.ready ??= this.client.connect();
    await this.ready;
    return this.client;
  }
  async put(id: string, value: string, ttlSeconds: number): Promise<void> {
    await (await this.c()).set(key(id), value, { EX: ttlSeconds });
  }
  async get(id: string): Promise<string | null> {
    const v = await (await this.c()).get(key(id));
    return typeof v === "string" ? v : null;
  }
  async delete(id: string): Promise<void> {
    await (await this.c()).del(key(id));
  }
  async close(): Promise<void> {
    if (this.ready) await this.client.quit();
  }
}

/** Redis when REDIS_URL is set (every deployed environment); in-memory otherwise. */
export function previewStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewStore {
  const url = env["REDIS_URL"];
  return url ? new RedisPreviewStore(url) : new MemoryPreviewStore();
}
