import { expect, it } from "vitest";
import { MemoryRoleCache, ROLE_CACHE_TTL_MS } from "./role-cache.js";

it("caches roles per user and workspace for 60 s, and clear() drops everything", () => {
  let now = 1_000;
  const cache = new MemoryRoleCache(() => now);
  const access = { isOrgAdmin: false, assignments: [{ role: "VIEWER" as const, scope: {} }] };
  cache.set("u1", "ws1", access);
  expect(cache.get("u1", "ws1")).toBe(access);
  expect(cache.get("u1", "ws2")).toBeUndefined();
  expect(cache.get("u1", null)).toBeUndefined();
  now += ROLE_CACHE_TTL_MS - 1;
  expect(cache.get("u1", "ws1")).toBe(access);
  now += 1;
  expect(cache.get("u1", "ws1")).toBeUndefined();
  cache.set("u1", "ws1", access);
  cache.clear();
  expect(cache.get("u1", "ws1")).toBeUndefined();
  expect(ROLE_CACHE_TTL_MS).toBe(60_000);
});
