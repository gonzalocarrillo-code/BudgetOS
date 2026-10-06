import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { JwtVerifier } from "./jwt-verifier.js";

/**
 * S-11: in session mode, JwtVerifier checks app_session_live (via @budget/db's sessionLive) for a
 * cookie that carries a jti, cached positively for a TTL that tests set to 0 so a revoke is
 * observable on the very next call instead of waiting out a real clock.
 */
const SESSION_KEY = "k".repeat(48);
const saved = { ...process.env };

beforeEach(() => {
  process.env["AUTH_MODE"] = "session";
  process.env["SESSION_KEY"] = SESSION_KEY;
});

afterEach(() => {
  process.env = saved;
});

/** A fake PrismaClient exposing only what sessionLive()'s $queryRaw call needs. */
function fakePrisma(live: Map<string, boolean>): PrismaClient {
  return {
    $queryRaw: async (_strings: TemplateStringsArray, jti: string) => [{ live: live.get(jti) === true }],
  } as unknown as PrismaClient;
}

const sign = (claims: Record<string, unknown>) =>
  new SignJWT({ typ: "session", email: "a@b.c", googleSub: "123", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("budget-os")
    .setAudience("budget-os-web")
    .setSubject("accounts.google.com:123")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SESSION_KEY));

describe("JwtVerifier, session mode (S-11)", () => {
  it("accepts a session with no jti unconditionally (an account not yet provisioned)", async () => {
    const verifier = new JwtVerifier(fakePrisma(new Map()));
    const token = await sign({});
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({ email: "a@b.c" });
  });

  it("accepts a live jti and refuses a revoked one, immediately once the cache TTL is 0", async () => {
    const live = new Map([["sess-1", true]]);
    const verifier = new JwtVerifier(fakePrisma(live));
    verifier.setSessionLiveCacheTtlMs(0);
    const token = await sign({ jti: "sess-1" });
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({ email: "a@b.c" });
    live.set("sess-1", false); // a logout / logout-all happened
    await expect(verifier.verify(`Bearer ${token}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("with a positive cache, a session revoked after the first check stays accepted within the TTL", async () => {
    const live = new Map([["sess-2", true]]);
    const verifier = new JwtVerifier(fakePrisma(live));
    verifier.setSessionLiveCacheTtlMs(60_000);
    const token = await sign({ jti: "sess-2" });
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({ email: "a@b.c" });
    live.set("sess-2", false);
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({ email: "a@b.c" });
  });
});
