import { createClient } from "@redis/client";
import { deletePreview, getPreview, putPreview, takePreview, type Tx } from "@budget/db";

/**
 * Where bulk-edit and budget-import previews live between preview and commit (spec §7.4, 30 min
 * TTL). ADR-0072 supersedes ADR-008's Redis requirement: Postgres (`PostgresPreviewStore`) is the
 * default, scoped by RLS to the caller's own transaction, so any API instance can commit a preview
 * another instance built. `put`/`get`/`take`/`delete` take the active tenant transaction so the
 * Postgres implementation runs inside the caller's `withTenant()`; the Memory and Redis
 * implementations ignore it (kept for tests and for `PREVIEW_STORE=redis` local/dev parity).
 */
export interface PreviewStore {
  put(tx: Tx, id: string, kind: string, value: string, ttlSeconds: number): Promise<void>;
  get(tx: Tx, id: string): Promise<string | null>;
  /** Atomic consume: returns the payload and deletes it in one statement. Null when missing,
   * expired, or already taken — so a double commit of the same preview can't both succeed. */
  take(tx: Tx, id: string): Promise<string | null>;
  delete(tx: Tx, id: string): Promise<void>;
}

export const PREVIEW_STORE = Symbol("PREVIEW_STORE");
export const PREVIEW_TTL_SECONDS = 30 * 60;
const key = (id: string) => `bulk:${id}`;

/** Single-process fallback for `PREVIEW_STORE=memory` (tests). Honors the TTL. `tx` and `kind` are
 * ignored: there is no tenant or ops concept to enforce in one process's memory. */
export class MemoryPreviewStore implements PreviewStore {
  private readonly items = new Map<string, { value: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async put(_tx: Tx, id: string, _kind: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key(id), { value, expires: this.now() + ttlSeconds * 1000 });
  }
  async get(_tx: Tx, id: string): Promise<string | null> {
    const hit = this.items.get(key(id));
    if (!hit) return null;
    if (hit.expires <= this.now()) {
      this.items.delete(key(id));
      return null;
    }
    return hit.value;
  }
  async take(tx: Tx, id: string): Promise<string | null> {
    const value = await this.get(tx, id);
    this.items.delete(key(id));
    return value;
  }
  async delete(_tx: Tx, id: string): Promise<void> {
    this.items.delete(key(id));
  }
}

/** Kept for `PREVIEW_STORE=redis` local/dev parity with pre-ADR-0072 deploys. `tx` and `kind` are
 * ignored. `take` is get-then-delete (not atomic): fine for local/dev, where this is opt-in only. */
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
  async put(_tx: Tx, id: string, _kind: string, value: string, ttlSeconds: number): Promise<void> {
    await (await this.c()).set(key(id), value, { EX: ttlSeconds });
  }
  async get(_tx: Tx, id: string): Promise<string | null> {
    const v = await (await this.c()).get(key(id));
    return typeof v === "string" ? v : null;
  }
  async take(tx: Tx, id: string): Promise<string | null> {
    const value = await this.get(tx, id);
    if (value !== null) await this.delete(tx, id);
    return value;
  }
  async delete(_tx: Tx, id: string): Promise<void> {
    await (await this.c()).del(key(id));
  }
  async close(): Promise<void> {
    if (this.ready) await this.client.quit();
  }
}

/** The deployed store (ADR-0072): previews in Postgres, RLS-scoped to the caller's own
 * transaction, consumed atomically on commit. */
export class PostgresPreviewStore implements PreviewStore {
  async put(tx: Tx, id: string, kind: string, value: string, ttlSeconds: number): Promise<void> {
    await putPreview(tx, id, kind, value, ttlSeconds);
  }
  async get(tx: Tx, id: string): Promise<string | null> {
    return getPreview(tx, id);
  }
  async take(tx: Tx, id: string): Promise<string | null> {
    return takePreview(tx, id);
  }
  async delete(tx: Tx, id: string): Promise<void> {
    await deletePreview(tx, id);
  }
}

/**
 * Postgres by default (ADR-0072: any API instance can commit a preview another instance built).
 * `PREVIEW_STORE=redis` keeps selecting Redis, for local/dev parity with earlier deploys, when
 * `REDIS_URL` is also set (falls back to Postgres if it isn't — a redis request with no URL is
 * never silently wrong). `PREVIEW_STORE=memory` is for tests without a database.
 */
export function previewStoreFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewStore {
  const mode = env["PREVIEW_STORE"];
  if (mode === "memory") return new MemoryPreviewStore();
  const url = env["REDIS_URL"];
  if (mode === "redis" && url) return new RedisPreviewStore(url);
  return new PostgresPreviewStore();
}
