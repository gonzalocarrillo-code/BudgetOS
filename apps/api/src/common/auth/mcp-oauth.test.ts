import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpOAuth } from "./mcp-oauth.js";

/** ADR-066: the MCP OAuth flow end to end, without a network: register, code with PKCE, tokens, refresh. */
const oauth = new McpOAuth("x".repeat(48));
const grant = { email: "gonzalo.carrillo@deptagency.com", googleSub: "1234567890" };
const verifier = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

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
