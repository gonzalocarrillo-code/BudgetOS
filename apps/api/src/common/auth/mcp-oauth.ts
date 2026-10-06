import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "@budget/domain";
import { SignJWT, errors, jwtVerify } from "jose";
import type { VerifiedIdentity } from "./jwt-verifier.js";

/**
 * OAuth for the MCP server (ADR-066), the MCP authorization spec's flow: discovery, dynamic client
 * registration, authorization code with PKCE (S256), refresh. Budget OS is its own authorization
 * server; clients, codes and tokens are HS256 JWTs signed with MCP_OAUTH_KEY (Secret Manager), each
 * with its own `typ`, so one kind is never accepted as another. Codes and refresh tokens additionally
 * carry a server-side record (`OAuthStore`, ADR-066 addendum, audit S-12): a code is single-use, and a
 * refresh token rotates and detects reuse — the JWT alone is no longer the sole source of truth for
 * those two.
 *
 * The person signs in where they already do: the authorization endpoint lives on `budgetos-app`,
 * behind IAP or session sign-in. It shows a consent page, then sends a code to the client's redirect
 * URI. The token endpoint and the MCP endpoint live on the public `budgetos-mcp`.
 */
const ISSUER = "budget-os";
export const MCP_AUDIENCE = "budget-os-mcp";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_S = 300;
// The refresh-token chain's 90-day absolute lifetime (ADR-066 addendum, audit S-12) is enforced
// server-side by app_consume_refresh (packages/db, migration 20261011000000), not here.

type Typ = "client" | "code" | "access" | "refresh" | "consent";

export interface McpClient {
  redirectUris: string[];
  name: string;
}

export interface Grant {
  email: string;
  googleSub: string;
  /** The Budget OS app_user id (ADR-066 addendum): carried in every code/token JWT so neither the
   * MCP server's exchange/refresh endpoints nor the refresh-token store need their own app_user lookup. */
  userId: string;
}

/**
 * Server-side persistence for codes and refresh tokens (migration 20261011000000, packages/db's
 * oauth-store.ts). `code()`/`exchangeCode()` run on the api side (issueCode only); `exchangeCode()`'s
 * single-use check and `refresh()`'s rotation run on the MCP side (consumeCode/issueRefresh/
 * consumeRefresh) — each side is wired with only the methods its own DB role can execute.
 */
export interface OAuthStore {
  issueCode(codeHash: string, expiresAt: Date): Promise<void>;
  consumeCode(codeHash: string): Promise<boolean>;
  issueRefresh(input: { jti: string; clientId: string; userId: string; chainStartedAt: Date; expiresAt: Date }): Promise<void>;
  consumeRefresh(jti: string): Promise<{ ok: boolean; reused: boolean; chainStartedAt: Date | null }>;
}

export class McpOAuth {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    /** Optional so the existing stateless unit tests (and a deploy with no store wired) keep working: without it, codes and refresh tokens are exactly as replayable as before this store existed. */
    private readonly store: OAuthStore | null = null,
  ) {
    if (secret.length < 32) throw new Error("MCP_OAUTH_KEY must be at least 32 characters");
    this.key = new TextEncoder().encode(secret);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, store: OAuthStore | null = null): McpOAuth | null {
    const secret = env["MCP_OAUTH_KEY"];
    return secret ? new McpOAuth(secret, store) : null;
  }

  private sign(typ: Typ, claims: Record<string, unknown>, ttl: number | null): Promise<string> {
    const jwt = new SignJWT({ ...claims, typ }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setIssuedAt();
    if (ttl !== null) jwt.setExpirationTime(`${ttl}s`);
    return jwt.sign(this.key);
  }

  private async read(typ: Typ, token: string): Promise<Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, algorithms: ["HS256"] });
      if (payload["typ"] !== typ) throw new Error(`not a ${typ}`);
      return payload;
    } catch (error) {
      const reason = error instanceof errors.JOSEError ? error.code : String(error);
      throw new DomainError("UNAUTHENTICATED", `Invalid ${typ}`, { reason });
    }
  }

  /** Dynamic client registration (RFC 7591): the client id carries its redirect URIs, signed. */
  async registerClient(client: McpClient): Promise<string> {
    for (const uri of client.redirectUris) {
      const u = new URL(uri);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new DomainError("VALIDATION", "redirect_uris must be https (or http on localhost)");
    }
    if (client.redirectUris.length === 0) throw new DomainError("VALIDATION", "redirect_uris is required");
    return this.sign("client", { redirect_uris: client.redirectUris, name: client.name.slice(0, 80) }, null);
  }

  async client(clientId: string): Promise<McpClient> {
    const p = await this.read("client", clientId);
    return { redirectUris: (p["redirect_uris"] as string[] | undefined) ?? [], name: String(p["name"] ?? "MCP client") };
  }

  /** The consent page's Allow link: binds the request to the person who saw it (no CSRF). */
  consent(grant: Grant, request: Record<string, string>): Promise<string> {
    return this.sign("consent", { ...grant, request }, CODE_TTL_S);
  }

  async readConsent(token: string): Promise<{ grant: Grant; request: Record<string, string> }> {
    const p = await this.read("consent", token);
    return { grant: grantOf(p), request: (p["request"] as Record<string, string> | undefined) ?? {} };
  }

  async code(grant: Grant, bound: { clientId: string; redirectUri: string; codeChallenge: string }): Promise<string> {
    const token = await this.sign("code", { ...grant, client: digest(bound.clientId), redirect_uri: bound.redirectUri, challenge: bound.codeChallenge }, CODE_TTL_S);
    if (this.store) await this.store.issueCode(hashToken(token), new Date(Date.now() + CODE_TTL_S * 1000));
    return token;
  }

  /** Authorization code → tokens, checking the client, the redirect URI, the PKCE verifier and (S-12) that the code was not already exchanged. */
  async exchangeCode(code: string, clientId: string, redirectUri: string, verifier: string): Promise<{ access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number }> {
    const p = await this.read("code", code);
    if (p["client"] !== digest(clientId) || p["redirect_uri"] !== redirectUri) throw new DomainError("UNAUTHENTICATED", "Code issued to another client");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== p["challenge"]) throw new DomainError("UNAUTHENTICATED", "PKCE verification failed");
    if (this.store && !(await this.store.consumeCode(hashToken(code)))) throw new DomainError("UNAUTHENTICATED", "Code already used or expired");
    return this.tokens(grantOf(p), clientId, new Date());
  }

  /** Refresh → a new access/refresh pair (S-12): rotates the refresh token and, on reuse of an
   * already-consumed one, revokes the whole chain so a stolen refresh token stops working the
   * moment its rightful owner uses theirs again. */
  async refresh(refreshToken: string, clientId: string): Promise<{ access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number }> {
    const p = await this.read("refresh", refreshToken);
    if (p["client"] !== digest(clientId)) throw new DomainError("UNAUTHENTICATED", "Refresh token issued to another client");
    let chainStartedAt = new Date();
    if (this.store) {
      const jti = String(p["jti"] ?? "");
      const result = await this.store.consumeRefresh(jti);
      if (!result.ok) throw new DomainError("UNAUTHENTICATED", result.reused ? "Refresh token already used: every token in this chain has been revoked" : "Refresh token invalid, revoked or expired");
      chainStartedAt = result.chainStartedAt ?? chainStartedAt;
    }
    return this.tokens(grantOf(p), clientId, chainStartedAt);
  }

  private async tokens(grant: Grant, clientId: string, chainStartedAt: Date) {
    const client = digest(clientId);
    const access_token = await this.sign("access", { ...grant, aud: MCP_AUDIENCE, client }, ACCESS_TTL_S);
    const jti = randomBytes(18).toString("base64url");
    const refresh_token = await this.sign("refresh", { ...grant, client, jti }, REFRESH_TTL_S);
    // chainStartedAt is fixed at the chain's first issuance (code exchange) and carried through
    // every rotation unchanged; app_consume_refresh already refused anything past its 90-day
    // absolute lifetime before refresh() ever gets here, so there is nothing to re-check.
    if (this.store) await this.store.issueRefresh({ jti, clientId: client, userId: grant.userId, chainStartedAt, expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000) });
    return { access_token, refresh_token, token_type: "Bearer" as const, expires_in: ACCESS_TTL_S };
  }

  /** The MCP server's verifier: its own access tokens, as the identity authenticate() expects. */
  verifier(): { verify(authorization: string | undefined): Promise<VerifiedIdentity>; credential(headers: Record<string, string | string[] | undefined>): string | undefined } {
    return {
      credential: (headers) => {
        const v = headers["authorization"];
        return Array.isArray(v) ? v[0] : v;
      },
      verify: async (authorization) => {
        const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
        if (!token) throw new DomainError("UNAUTHENTICATED", "Missing bearer token");
        const p = await this.read("access", token);
        if (p["aud"] !== MCP_AUDIENCE) throw new DomainError("UNAUTHENTICATED", "Invalid access token");
        const email = String(p["email"]).toLowerCase();
        const googleSub = String(p["googleSub"]);
        return { sub: `accounts.google.com:${googleSub}`, email, emailVerified: true, googleSub };
      },
    };
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 22);
/** A full hash (unlike digest(), not truncated): the primary key of oauth_code, never a secret the code itself is not already. */
const hashToken = (s: string) => createHash("sha256").update(s).digest("base64url");
const grantOf = (p: Record<string, unknown>): Grant => ({ email: String(p["email"]), googleSub: String(p["googleSub"]), userId: String(p["userId"]) });
