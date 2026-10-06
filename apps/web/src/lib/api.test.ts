import { describe, expect, it } from "vitest";
import { idempotentFetch } from "./api.js";

/** W3-2 (spec §17, ADR-0081): the web client's Idempotency-Key. */
describe("idempotentFetch", () => {
  const post = () => new Request("http://localhost/api/v1/workspaces/w/envelopes", { method: "POST", body: JSON.stringify({ name: "A" }), headers: { "content-type": "application/json" } });

  it("sends a fresh key on every mutation and none on a read", async () => {
    const seen: Array<string | null> = [];
    const fetch = async (r: Request) => (seen.push(r.headers.get("idempotency-key")), new Response("{}", { status: 201 }));
    await idempotentFetch(post(), { fetch });
    await idempotentFetch(post(), { fetch });
    await idempotentFetch(new Request("http://localhost/api/v1/me"), { fetch });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[2]).toBeNull();
  });

  it("retries once after a network failure or a 503 with the same key and the same body", async () => {
    for (const fail of [() => Promise.reject(new TypeError("Failed to fetch")), () => Promise.resolve(new Response("{}", { status: 503 }))]) {
      const seen: Array<{ key: string | null; body: string }> = [];
      let calls = 0;
      const fetch = async (r: Request) => {
        seen.push({ key: r.headers.get("idempotency-key"), body: await r.text() });
        calls += 1;
        return calls === 1 ? fail() : new Response("{}", { status: 201 });
      };
      const res = await idempotentFetch(post(), { fetch, retryDelayMs: 0 });
      expect(res.status).toBe(201);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(seen[0]);
      expect(seen[0]?.body).toBe(JSON.stringify({ name: "A" }));
    }
  });

  it("does not retry a refusal, and keeps a key the caller set", async () => {
    let calls = 0;
    const res = await idempotentFetch(new Request("http://localhost/x", { method: "PATCH", headers: { "idempotency-key": "mine" } }), {
      fetch: async (r) => (calls++, new Response(JSON.stringify({ key: r.headers.get("idempotency-key") }), { status: 422 })),
      retryDelayMs: 0,
    });
    expect(res.status).toBe(422);
    expect(calls).toBe(1);
    expect(await res.json()).toEqual({ key: "mine" });
  });
});
