import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IAP_HEADER, JwtVerifier } from "./jwt-verifier.js";

/** ADR-065: behind IAP the caller is IAP's ES256 assertion header; a bearer token is ignored. */
const AUDIENCE = "/projects/123/locations/us-central1/services/budgetos-app";
let server: Server;
let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const saved = { ...process.env };

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "iap-test", alg: "ES256" };
  server = createServer((_, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] })));
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

const assertion = (claims: Record<string, unknown>, audience = AUDIENCE) =>
  new SignJWT({ email: "Gonzalo.Carrillo@deptagency.com", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "iap-test" })
    .setIssuer("https://cloud.google.com/iap")
    .setAudience(audience)
    .setSubject("accounts.google.com:1234567890")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);

describe("JwtVerifier in IAP mode", () => {
  it("reads the IAP header, not Authorization, and maps the Google account", async () => {
    const verifier = new JwtVerifier();
    const token = await assertion({});
    const credential = verifier.credential({ [IAP_HEADER]: token, authorization: "Bearer something-else" });
    expect(credential).toBe(`Bearer ${token}`);
    await expect(verifier.verify(credential)).resolves.toEqual({ sub: "accounts.google.com:1234567890", email: "gonzalo.carrillo@deptagency.com", emailVerified: true, googleSub: "1234567890" });
  });

  it("refuses a request without the header, and an assertion for another service", async () => {
    const verifier = new JwtVerifier();
    expect(verifier.credential({ authorization: "Bearer x" })).toBeUndefined();
    await expect(verifier.verify(undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(verifier.verify(`Bearer ${await assertion({}, "/projects/123/locations/us-central1/services/other")}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
