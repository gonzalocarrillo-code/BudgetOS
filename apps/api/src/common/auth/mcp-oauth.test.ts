import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpOAuth, type OAuthStore } from "./mcp-oauth.js";

/** ADR-066: the MCP OAuth flow end to end, without a network: register, code with PKCE, tokens, refresh. */
const oauth = new McpOAuth("x".repeat(48));
const grant = { email: "gonzalo.carrillo@deptagency.com", googleSub: "1234567890", userId: "11111111-1111-1111-1111-111111111111" };
const verifier = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

/**
 * An in-memory stand-in for packages/db's oauth-store.ts, mirroring app_consume_refresh's rules
 * exactly (migration 20261011000000) so these tests exercise McpOAuth's own rotation/reuse-detection
 * wiring; the SQL function itself is exercised for real in packages/db/src/auth-session.test.ts.
 * `now` is injectable so the 90-day absolute lifetime is testable without a real clock.
 */
function fakeStore(now: () => Date = () => new Date()): OAuthStore {
  const codes = new Map<string, { expiresAt: Date; usedAt: Date | null }>();
  const refreshes = new Map<string, { clientId: string; userId: string; chainStartedAt: Date; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null }>();
  return {
    async issueCode(codeHash, expiresAt) {
      codes.set(codeHash, { expiresAt, usedAt: null });
    },
    async consumeCode(codeHash) {
      const row = codes.get(codeHash);
      if (!row || row.usedAt !== null || row.expiresAt <= now()) return false;
      row.usedAt = now();
      return true;
    },
    async issueRefresh({ jti, clientId, userId, chainStartedAt, expiresAt }) {
      refreshes.set(jti, { clientId, userId, chainStartedAt, expiresAt, usedAt: null, revokedAt: null });
    },
    async consumeRefresh(jti) {
      const row = refreshes.get(jti);
      if (!row) return { ok: false, reused: false, chainStartedAt: null };
      const n = now();
      if (row.revokedAt !== null || row.expiresAt <= n || row.chainStartedAt.getTime() <= n.getTime() - 90 * 86_400_000) {
        return { ok: false, reused: false, chainStartedAt: row.chainStartedAt };
      }
      if (row.usedAt !== null) {
        for (const r of refreshes.values()) if (r.clientId === row.clientId && r.userId === row.userId && r.revokedAt === null) r.revokedAt = n;
        return { ok: false, reused: true, chainStartedAt: row.chainStartedAt };
      }
      row.usedAt = n;
      return { ok: true, reused: false, chainStartedAt: row.chainStartedAt };
    },
  };
}

describe("McpOAuth", () => {
  it("issues tokens only for the registered client, redirect URI and PKCE verifier", async () => {
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    expect(await oauth.client(clientId)).toEqual({ redirectUris: [redirectUri], name: "Claude" });
    const code = await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge });
    await expect(oauth.exchangeCode(code, clientId, redirectUri, "wrong")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(oauth.exchangeCode(code, clientId, "https://evil.example/cb", verifier)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const tokens = await oauth.exchangeCode(code, clientId, redirectUri, verifier);
    expect(tokens.token_type).toBe("Bearer");
    const identity = await oauth.verifier().verify(`Bearer ${tokens.access_token}`);
    expect(identity).toEqual({ sub: "accounts.google.com:1234567890", email: grant.email, emailVerified: true, googleSub: "1234567890" });
    const again = await oauth.refresh(tokens.refresh_token, clientId);
    await expect(oauth.verifier().verify(`Bearer ${again.access_token}`)).resolves.toMatchObject({ email: grant.email });
  });

  it("never takes one kind of token for another, nor a non-https redirect", async () => {
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    const tokens = await oauth.exchangeCode(await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge }), clientId, redirectUri, verifier);
    await expect(oauth.verifier().verify(`Bearer ${tokens.refresh_token}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(oauth.verifier().verify(`Bearer ${clientId}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(oauth.refresh(tokens.access_token, clientId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(oauth.registerClient({ redirectUris: ["http://evil.example/cb"], name: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(oauth.registerClient({ redirectUris: ["http://localhost:6274/cb"], name: "Inspector" })).resolves.toBeTypeOf("string");
    await expect(new McpOAuth("y".repeat(48)).verifier().verify(`Bearer ${tokens.access_token}`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("McpOAuth with a server-side store (ADR-066 addendum, audit S-12)", () => {
  it("a code can be exchanged only once; a replay is refused", async () => {
    const oauth = new McpOAuth("x".repeat(48), fakeStore());
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    const code = await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge });
    await oauth.exchangeCode(code, clientId, redirectUri, verifier);
    await expect(oauth.exchangeCode(code, clientId, redirectUri, verifier)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("a refresh token rotates; replaying an already-rotated one revokes the whole chain", async () => {
    const oauth = new McpOAuth("x".repeat(48), fakeStore());
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    const code = await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge });
    const first = await oauth.exchangeCode(code, clientId, redirectUri, verifier);
    const second = await oauth.refresh(first.refresh_token, clientId); // legitimate rotation
    await expect(oauth.verifier().verify(`Bearer ${second.access_token}`)).resolves.toMatchObject({ email: grant.email });
    // Replaying the already-rotated token is refused...
    await expect(oauth.refresh(first.refresh_token, clientId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // ...and revoked the whole chain, including the most recent token, which was never itself replayed.
    await expect(oauth.refresh(second.refresh_token, clientId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("enforces the 90-day absolute chain lifetime, regardless of the token's own (unexpired) TTL", async () => {
    // The chain's start is fixed at first issuance (real time); to test the 90-day boundary without
    // waiting 90 real days, this store backdates it the way a chain that started long ago would
    // actually look, rather than needing to fast-forward a clock inside McpOAuth itself (it has
    // none — the absolute lifetime is entirely the store's own policy, exercised for real against
    // Postgres in packages/db/src/auth-session.test.ts).
    const base = fakeStore();
    const longAgo = new Date(Date.now() - 91 * 86_400_000);
    const store: OAuthStore = { ...base, issueRefresh: (input) => base.issueRefresh({ ...input, chainStartedAt: longAgo }) };
    const oauth = new McpOAuth("x".repeat(48), store);
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    const code = await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge });
    const first = await oauth.exchangeCode(code, clientId, redirectUri, verifier);
    await expect(oauth.refresh(first.refresh_token, clientId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("without a store, refresh still works but never rotates or detects reuse (pre-existing behaviour, unchanged)", async () => {
    const oauth = new McpOAuth("x".repeat(48));
    const clientId = await oauth.registerClient({ redirectUris: [redirectUri], name: "Claude" });
    const code = await oauth.code(grant, { clientId, redirectUri, codeChallenge: challenge });
    const tokens = await oauth.exchangeCode(code, clientId, redirectUri, verifier);
    await expect(oauth.refresh(tokens.refresh_token, clientId)).resolves.toMatchObject({ token_type: "Bearer" });
    await expect(oauth.refresh(tokens.refresh_token, clientId)).resolves.toMatchObject({ token_type: "Bearer" }); // no store: replay is not even detectable
  });
});
