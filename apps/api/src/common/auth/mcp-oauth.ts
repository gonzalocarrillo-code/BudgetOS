import { createHash } from "node:crypto";
import { DomainError } from "@budget/domain";
import { SignJWT, errors, jwtVerify } from "jose";
import type { VerifiedIdentity } from "./jwt-verifier.js";

/**
 * OAuth for the MCP server (ADR-066), the MCP authorization spec's flow: discovery, dynamic client
 * registration, authorization code with PKCE (S256), refresh. Budget OS is its own authorization
 * server, stateless: clients, codes and tokens are HS256 JWTs signed with MCP_OAUTH_KEY (Secret
 * Manager), each with its own `typ`, so one kind is never accepted as another.
 *
 * The person signs in where they already do: the authorization endpoint lives on `budgetos-app`,
 * behind IAP (Google). It shows a consent page, then sends a code to the client's redirect URI. The
 * token endpoint and the MCP endpoint live on the public `budgetos-mcp`.
 */
const ISSUER = "budget-os";
export const MCP_AUDIENCE = "budget-os-mcp";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_S = 300;

type Typ = "client" | "code" | "access" | "refresh" | "consent";

export interface McpClient {
  redirectUris: string[];
  name: string;
}

export interface Grant {
  email: string;
  googleSub: string;
}

export class McpOAuth {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("MCP_OAUTH_KEY must be at least 32 characters");
    this.key = new TextEncoder().encode(secret);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): McpOAuth | null {
    const secret = env["MCP_OAUTH_KEY"];
    return secret ? new McpOAuth(secret) : null;
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
    return { grant: { email: String(p["email"]), googleSub: String(p["googleSub"]) }, request: (p["request"] as Record<string, string> | undefined) ?? {} };
  }

  code(grant: Grant, bound: { clientId: string; redirectUri: string; codeChallenge: string }): Promise<string> {
    return this.sign("code", { ...grant, client: digest(bound.clientId), redirect_uri: bound.redirectUri, challenge: bound.codeChallenge }, CODE_TTL_S);
  }

  /** Authorization code → tokens, checking the client, the redirect URI and the PKCE verifier. */
  async exchangeCode(code: string, clientId: string, redirectUri: string, verifier: string): Promise<{ access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number }> {
    const p = await this.read("code", code);
    if (p["client"] !== digest(clientId) || p["redirect_uri"] !== redirectUri) throw new DomainError("UNAUTHENTICATED", "Code issued to another client");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== p["challenge"]) throw new DomainError("UNAUTHENTICATED", "PKCE verification failed");
    return this.tokens({ email: String(p["email"]), googleSub: String(p["googleSub"]) }, clientId);
  }

  async refresh(refreshToken: string, clientId: string): Promise<{ access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number }> {
    const p = await this.read("refresh", refreshToken);
    if (p["client"] !== digest(clientId)) throw new DomainError("UNAUTHENTICATED", "Refresh token issued to another client");
    return this.tokens({ email: String(p["email"]), googleSub: String(p["googleSub"]) }, clientId);
  }

  private async tokens(grant: Grant, clientId: string) {
    const client = digest(clientId);
    return {
      access_token: await this.sign("access", { ...grant, aud: MCP_AUDIENCE, client }, ACCESS_TTL_S),
      refresh_token: await this.sign("refresh", { ...grant, client }, REFRESH_TTL_S),
      token_type: "Bearer" as const,
      expires_in: ACCESS_TTL_S,
    };
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
