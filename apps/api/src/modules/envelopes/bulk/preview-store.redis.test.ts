import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { RedisPreviewStore, previewStoreFromEnv, MemoryPreviewStore } from "./preview-store.js";

/** The deployed preview store (spec §7.4: Redis, 30 min). Runs when REDIS_URL points at a Redis. */
const url = process.env["REDIS_URL"];
const store = url ? new RedisPreviewStore(url) : null;

afterAll(async () => {
  await store?.close();
});

describe.skipIf(!url)("RedisPreviewStore", () => {
  it("stores under bulk:<id> with a TTL, reads back, deletes", async () => {
    const id = randomUUID();
    await store!.put(id, '{"x":1}', 2);
    expect(await store!.get(id)).toBe('{"x":1}');
    await store!.delete(id);
    expect(await store!.get(id)).toBeNull();
    await store!.put(id, "short", 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store!.get(id)).toBeNull();
  });
});

it("previewStoreFromEnv picks Redis only when REDIS_URL is set", () => {
  expect(previewStoreFromEnv({})).toBeInstanceOf(MemoryPreviewStore);
  expect(previewStoreFromEnv({ REDIS_URL: "redis://127.0.0.1:1" })).toBeInstanceOf(RedisPreviewStore);
});
