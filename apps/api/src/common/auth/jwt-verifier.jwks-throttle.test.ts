import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtVerifier } from "./jwt-verifier.js";

/**
 * S-20: an IAP assertion whose `kid` the cached key set has never seen triggers a refetch (the
 * key may have just rotated); without a throttle, a burst of such assertions (a stale cache, or
 * someone probing) sends one upstream fetch per request. This asserts the fetch count stays 1
 * across 10 requests, all with a `kid` the server's (single-key) JWKS never carries.
 */
const AUDIENCE = "/projects/123/locations/us-central1/services/budgetos-app";
let server: Server;
let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let fetches = 0;
const saved = { ...process.env };

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "the-real-kid", alg: "ES256" };
  server = createServer((_, res) => {
    fetches += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["AUTH_MODE"] = "iap";
  process.env["AUTH_AUDIENCE"] = AUDIENCE;
  process.env["AUTH_JWKS_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
  delete process.env["AUTH_ISSUER"];
});

afterAll(() => {
  server.close();
  process.env = saved;
});

const assertion = () =>
  new SignJWT({ email: "person@deptagency.com" })
    .setProtectedHeader({ alg: "ES256", kid: "unknown-kid" })
    .setIssuer("https://cloud.google.com/iap")
    .setAudience(AUDIENCE)
    .setSubject("accounts.google.com:1234567890")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);

describe("JwtVerifier JWKS refetch throttle (S-20)", () => {
  it("refetches at most once per 60s even when every request carries an unknown kid", async () => {
    const verifier = new JwtVerifier();
    const token = await assertion();
    for (let i = 0; i < 10; i++) {
      await expect(verifier.verify(`Bearer ${token}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    // One fetch to populate the cache the first time; the following 9 unknown-kid verifications
    // within the same 60s window are throttled and reuse the same (still-wrong) key set.
    expect(fetches).toBe(1);
  });
});
