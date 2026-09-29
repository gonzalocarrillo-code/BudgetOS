import { createHash } from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { createClient } from "@redis/client";
import { isPredicate, type FilterGroupT, type QueryRequest } from "@budget/domain";

/**
 * Where a heavy query runs and how it is remembered (spec §6.2 routing rule, ADR-042).
 *
 * - **Cache:** Redis (in memory without REDIS_URL), 5 minutes, keyed by workspace, data version and
 *   the scoped query (the caller's read scope is part of its filter). Only queries whose filter
 *   reads dimensions, status and is_leaf are kept: tags, threads and mentions change without a
 *   data-version bump.
 * - **Warehouse:** with BIGQUERY_DATASET set, the grouped shapes the BigQuery dialect supports run there when
 *   the period spans more than 13 months or Postgres estimates more than 200k rows.
 */

export const QUERY_CACHE_TTL_SECONDS = 300;
export const HEAVY_ROWS = 200_000;
export const HEAVY_MONTHS = 13;

export interface QueryCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryQueryCache implements QueryCache {
  private readonly items = new Map<string, { value: string; until: number }>();
  async get(key: string) {
    const hit = this.items.get(key);
    if (!hit || hit.until < Date.now()) return null;
    return hit.value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (this.items.size > 500) this.items.delete(this.items.keys().next().value as string);
    this.items.set(key, { value, until: Date.now() + ttlSeconds * 1000 });
  }
}

export class RedisQueryCache implements QueryCache {
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
  async get(key: string) {
    const v = await (await this.c()).get(key);
    return typeof v === "string" ? v : null;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await (await this.c()).set(key, value, { EX: ttlSeconds });
  }
}

export type Row = Record<string, unknown>;

/** A read-only warehouse the BigQuery dialect runs on (BigQuery in every deployed environment). */
export interface Warehouse {
  dataset: string;
  query(sql: string, params: Record<string, unknown>, types: Record<string, string | string[]>): Promise<Row[]>;
}

/** BigQuery NUMERIC/BIGNUMERIC come back as objects, DATEs as { value }: plain strings, as Postgres returns them. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object" && "value" in (v as object) && typeof (v as { value: unknown }).value === "string") return (v as { value: string }).value;
  return String(v);
}

export class BigQueryWarehouse implements Warehouse {
  private readonly client: BigQuery;
  constructor(readonly dataset: string, projectId?: string, private readonly location?: string) {
    this.client = new BigQuery(projectId ? { projectId } : {});
  }
  async query(sql: string, params: Record<string, unknown>, types: Record<string, string | string[]>): Promise<Row[]> {
    const [rows] = await this.client.query({ query: sql, params, types, ...(this.location ? { location: this.location } : {}) });
    return (rows as Row[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  }
}

export interface QueryEngine {
  cache: QueryCache | null;
  warehouse: Warehouse | null;
}

let fromEnv: QueryEngine | null = null;
/** The process's engine: Redis cache when REDIS_URL is set, BigQuery when BIGQUERY_DATASET is. */
export function engineFromEnv(env: NodeJS.ProcessEnv = process.env): QueryEngine {
  fromEnv ??= {
    // Off under test runners (fixtures write through the owner role, without a data-version bump)
    // unless QUERY_CACHE=on; the engine tests pass their own.
    cache: env["QUERY_CACHE"] === "off" || (env["VITEST"] && env["QUERY_CACHE"] !== "on") ? null : env["REDIS_URL"] ? new RedisQueryCache(env["REDIS_URL"]) : new MemoryQueryCache(),
    warehouse: env["BIGQUERY_DATASET"] ? new BigQueryWarehouse(env["BIGQUERY_DATASET"], env["BIGQUERY_PROJECT"], env["BIGQUERY_LOCATION"]) : null,
  };
  return fromEnv;
}

const CACHEABLE_ATTRS = new Set(["status", "is_leaf"]);
function cacheSafe(g: FilterGroupT): boolean {
  return g.children.every((c) => (isPredicate(c) ? c.field.kind === "dimension" || (c.field.kind === "attr" && CACHEABLE_ATTRS.has(c.field.key)) : cacheSafe(c)));
}

/** The cache key of a scoped query, or null when it may not be cached. */
export function cacheKey(q: QueryRequest, dataVersion: number, today: string, elapsedThrough?: string): string | null {
  if (!cacheSafe(q.filter ?? { logic: "and", children: [] })) return null;
  // `today` is part of the answer (pace, relative periods), and so is the day time gone is counted to (ADR-062).
  const day = elapsedThrough === undefined || elapsedThrough >= today ? today : `${today}~${elapsedThrough}`;
  return `q:${q.workspaceId}:${dataVersion}:${day}:${createHash("sha256").update(JSON.stringify(q)).digest("hex")}`;
}

/** Months the period spans, counting partial months. */
export function monthsSpanned(period: { start: string; end: string }): number {
  const [ys, ms] = [Number(period.start.slice(0, 4)), Number(period.start.slice(5, 7))];
  const [ye, me] = [Number(period.end.slice(0, 4)), Number(period.end.slice(5, 7))];
  return (ye - ys) * 12 + (me - ms) + 1;
}

/** The largest row estimate of any node in a Postgres EXPLAIN (FORMAT JSON) plan. */
export function maxPlanRows(plan: unknown): number {
  let max = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n["Plan Rows"] === "number") max = Math.max(max, n["Plan Rows"]);
    for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
  };
  walk(plan);
  return max;
}
