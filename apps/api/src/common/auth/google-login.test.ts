import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, cookie, loginCallback, loginRedirect, safeNext, verifySession } from "./google-login.js";

/** ADR-067: Budget OS's own Google sign-in, against a fake Google (its key and token endpoint). */
const config = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "secret", sessionKey: "k".repeat(48), baseUrl: "https://budgetos.example" };
let sign: (claims: Record<string, unknown>) => Promise<string>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "g1", alg: "RS256" }] });
  sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "g1" }).setIssuer("https://accounts.google.com").setAudience(config.clientId).setSubject("1122334455").setIssuedAt().setExpirationTime("5m").sign(privateKey);
});

/** Starts a login and returns what Google would send back, with the browser's state cookie. */
async function start(next = "/w/abc/home") {
  const r = await loginRedirect(config, next);
  const url = new URL(r.location);
  const nonce = decodeURIComponent(/budgetos_oauth=([^;]+)/.exec(r.setCookie)?.[1] ?? "");
  return { url, state: url.searchParams.get("state") ?? "", nonce, cookieHeader: `budgetos_oauth=${encodeURIComponent(nonce)}` };
}
const google = (idToken: string): typeof fetch => (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("Google login", () => {
  it("sends any Google account to Google with the app's client, a state and a nonce", async () => {
    const { url, nonce } = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://budgetos.example/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.has("hd")).toBe(false); // not only DEPT accounts
  });

  it("turns Google's answer into a session the API accepts, and returns to where the person was", async () => {
    const s = await start("/w/abc/budgets");
    const r = await loginCallback(config, { code: "c", state: s.state }, s.cookieHeader, google(await sign({ email: "Someone@Gmail.com", email_verified: true, nonce: s.nonce, name: "Some One" })), jwks);
    expect(r.location).toBe("/w/abc/budgets");
    const session = cookie(r.setCookies[0], SESSION_COOKIE);
    expect(r.setCookies[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    await expect(verifySession(config.sessionKey, session ?? "")).resolves.toEqual({ sub: "accounts.google.com:1122334455", email: "someone@gmail.com", emailVerified: true, googleSub: "1122334455" });
  });

  it("refuses another browser's state, a replayed nonce, an unverified email and a foreign session", async () => {
    const s = await start();
    const token = await sign({ email: "a@b.c", email_verified: true, nonce: s.nonce });
    await expect(loginCallback(config, { code: "c", state: s.state }, "budgetos_oauth=other", google(token), jwks)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(loginCallback(config, { code: "c", state: s.state }, s.cookieHeader, google(await sign({ email: "a@b.c", email_verified: true, nonce: "not-it" })), jwks)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(loginCallback(config, { code: "c", state: s.state }, s.cookieHeader, google(await sign({ email: "a@b.c", email_verified: false, nonce: s.nonce })), jwks)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(verifySession("x".repeat(48), "not.a.session")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("never sends the person to another site after signing in", () => {
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/w/abc")).toBe("/w/abc");
  });
});
