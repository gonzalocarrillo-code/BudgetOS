import { randomUUID } from "node:crypto";
import type { Tx } from "@budget/db";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryPreviewStore, PostgresPreviewStore, RedisPreviewStore, previewStoreFromEnv } from "./preview-store.js";

/** Kept for `PREVIEW_STORE=redis` local/dev parity (ADR-0072 made Postgres the default). Runs when
 * REDIS_URL points at a Redis; ignores the `tx` param everywhere (there is no tenant transaction
 * to test here — only the Postgres store needs one, covered by preview-store.postgres.test.ts). */
const url = process.env["REDIS_URL"];
const store = url ? new RedisPreviewStore(url) : null;
const fakeTx = {} as unknown as Tx;

afterAll(async () => {
  await store?.close();
});

describe.skipIf(!url)("RedisPreviewStore", () => {
  it("stores under bulk:<id> with a TTL, reads back, deletes", async () => {
    const id = randomUUID();
    await store!.put(fakeTx, id, "test", '{"x":1}', 2);
    expect(await store!.get(fakeTx, id)).toBe('{"x":1}');
    await store!.delete(fakeTx, id);
    expect(await store!.get(fakeTx, id)).toBeNull();
    await store!.put(fakeTx, id, "test", "short", 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store!.get(fakeTx, id)).toBeNull();
  });

  it("take returns the payload and deletes it; a second take is null", async () => {
    const id = randomUUID();
    await store!.put(fakeTx, id, "test", '{"y":2}', 2);
    expect(await store!.take(fakeTx, id)).toBe('{"y":2}');
    expect(await store!.take(fakeTx, id)).toBeNull();
  });
});

it("previewStoreFromEnv: Postgres by default, Redis only with PREVIEW_STORE=redis and REDIS_URL, memory only with PREVIEW_STORE=memory", () => {
  expect(previewStoreFromEnv({})).toBeInstanceOf(PostgresPreviewStore);
  expect(previewStoreFromEnv({ REDIS_URL: "redis://127.0.0.1:1" })).toBeInstanceOf(PostgresPreviewStore); // REDIS_URL alone no longer opts in
  expect(previewStoreFromEnv({ PREVIEW_STORE: "redis" })).toBeInstanceOf(PostgresPreviewStore); // redis requested but no URL: safe fallback
  expect(previewStoreFromEnv({ REDIS_URL: "redis://127.0.0.1:1", PREVIEW_STORE: "redis" })).toBeInstanceOf(RedisPreviewStore);
  expect(previewStoreFromEnv({ PREVIEW_STORE: "memory" })).toBeInstanceOf(MemoryPreviewStore);
});
