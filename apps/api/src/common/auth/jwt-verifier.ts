import { gunzipSync } from "node:zlib";
import { DomainError } from "@budget/domain";
import { SESSION_COOKIE, cookie, verifySession } from "./google-login.js";
import { Injectable } from "@nestjs/common";
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

/** Google's public keys for Identity Platform (securetoken) ID tokens. */
const IDENTITY_PLATFORM_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/** Identity-Aware Proxy's signing keys and issuer (ADR-0080). */
const IAP_JWKS = "https://www.gstatic.com/iap/verify/public_key-jwk";
const IAP_ISSUER = "https://cloud.google.com/iap";
/** The header IAP adds to every request it lets through. */
export const IAP_HEADER = "x-goog-iap-jwt-assertion";

export interface VerifiedIdentity {
  /** Identity Platform uid (`sub`). */
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Google account id from `firebase.identities["google.com"]`, when signed in with Google. */
  googleSub: string | null;
}

export interface AuthConfig {
  /** `identity-platform` (a bearer ID token), `iap` (the IAP assertion header, ADR-0080), or `session` (Budget OS's own Google sign-in cookie, ADR-067). */
  mode: "identity-platform" | "iap" | "session";
  /** session mode: the key sessions are signed with. */
  sessionKey?: string;
  issuer: string;
  audience: string;
  jwksUrl: string;
}

/**
 * Reads AUTH_* from the environment. There is no bypass: missing config fails at startup.
 * AUTH_MODE=iap: the service sits behind Identity-Aware Proxy, which signs in with Google and
 * vouches for the caller in `x-goog-iap-jwt-assertion`; AUTH_AUDIENCE is then the IAP audience
 * (`/projects/<number>/locations/<region>/services/<service>` for Cloud Run).
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const audience = env["AUTH_AUDIENCE"];
  if (env["AUTH_MODE"] === "session") {
    const sessionKey = env["SESSION_KEY"];
    if (!sessionKey) throw new Error("SESSION_KEY is required with AUTH_MODE=session");
    return { mode: "session", audience: "budget-os-web", issuer: "budget-os", jwksUrl: "", sessionKey };
  }
  if (env["AUTH_MODE"] === "iap") {
    if (!audience) throw new Error("AUTH_AUDIENCE is required (the IAP audience)");
    return { mode: "iap", audience, issuer: env["AUTH_ISSUER"] ?? IAP_ISSUER, jwksUrl: env["AUTH_JWKS_URL"] ?? IAP_JWKS };
  }
  if (!audience) throw new Error("AUTH_AUDIENCE is required (Identity Platform project id)");
  return {
    mode: "identity-platform",
    audience,
    issuer: env["AUTH_ISSUER"] ?? `https://securetoken.google.com/${audience}`,
    jwksUrl: env["AUTH_JWKS_URL"] ?? IDENTITY_PLATFORM_JWKS,
  };
}

/** Validates Identity Platform ID tokens (RS256) against the configured JWKS, issuer and audience. */
@Injectable()
export class JwtVerifier {
  private readonly config: AuthConfig;
  private readonly jwks: Parameters<typeof jwtVerify>[1] & ((...args: never[]) => unknown);

  constructor() {
    this.config = authConfigFromEnv();
    // session mode checks its own HS256 cookie and never reads a key set.
    this.jwks = this.config.mode === "identity-platform" ? createRemoteJWKSet(new URL(this.config.jwksUrl)) : fetchedJwks(this.config.jwksUrl);
  }

  /** The credential of a request: the IAP assertion behind IAP, else the bearer token. */
  credential(headers: Record<string, string | string[] | undefined>): string | undefined {
    const pick = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (this.config.mode === "session") {
      const session = cookie(headers["cookie"], SESSION_COOKIE);
      return session ? `Bearer ${session}` : undefined;
    }
    if (this.config.mode === "iap") {
      const assertion = pick(IAP_HEADER);
      if (process.env["IAP_DEBUG"] === "1") {
        const shape = Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("x-goog") || k.startsWith("x-serverless") || k === "authorization").map(([k, v]) => [k, { n: Array.isArray(v) ? v.length : 1, len: String(v).length, parts: String(v).split(".").length, head: String(v).slice(0, 12) }]));
        process.stdout.write(`${JSON.stringify({ level: 40, msg: "IAP headers", shape })}\n`);
      }
      return assertion ? `Bearer ${assertion}` : undefined;
    }
    return pick("authorization");
  }

  async verify(authorization: string | undefined): Promise<VerifiedIdentity> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    const token = match?.[1];
    if (token === undefined) throw new DomainError("UNAUTHENTICATED", "Missing bearer token");
    if (this.config.mode === "session") return verifySession(this.config.sessionKey ?? "", token);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.mode === "iap" ? ["ES256"] : ["RS256"],
      }));
    } catch (error) {
      const reason = error instanceof errors.JOSEError ? error.code : "ERR_JWT_INVALID";
      // Behind IAP, say what came (never the signature) so a misconfigured audience is visible.
      if (this.config.mode === "iap") {
        const claims = (() => {
          try {
            const [h, p] = token.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part ?? "", "base64url").toString()) as Record<string, unknown>);
            return { alg: h?.["alg"], kid: h?.["kid"], iss: p?.["iss"], aud: p?.["aud"], expected: this.config.audience, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
          } catch {
            return { unreadable: true };
          }
        })();
        process.stdout.write(`${JSON.stringify({ level: 40, msg: "IAP assertion rejected", reason, ...claims })}\n`);
      }
      throw new DomainError("UNAUTHENTICATED", "Invalid token", { reason });
    }
    const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : null;
    if (!payload.sub || email === null) throw new DomainError("UNAUTHENTICATED", "Token lacks sub or email");
    // IAP: Google verified the account; `sub` is "accounts.google.com:<google id>".
    if (this.config.mode === "iap") return { sub: payload.sub, email, emailVerified: true, googleSub: payload.sub.replace(/^accounts\.google\.com:/, "") };
    return { sub: payload.sub, email, emailVerified: payload["email_verified"] === true, googleSub: googleIdentity(payload) };
  }
}

function googleIdentity(payload: JWTPayload): string | null {
  const firebase = payload["firebase"];
  if (typeof firebase !== "object" || firebase === null) return null;
  const identities = (firebase as { identities?: Record<string, unknown> }).identities;
  const google = identities?.["google.com"];
  return Array.isArray(google) && typeof google[0] === "string" ? google[0] : null;
}

/**
 * IAP's keys, fetched with Node's fetch and cached for an hour (ADR-0080). On Cloud Run jose's
 * remote key set failed to parse gstatic's response ("Failed to parse the JSON Web Key Set HTTP
 * response as JSON") although the same URL parses everywhere else; an unknown `kid` refetches.
 * S-20: that unknown-`kid` refetch is throttled to once per 60 s, so a burst of assertions signed
 * with a `kid` that never matches (a stale cache, or probing) costs one upstream fetch, not one
 * per request.
 */
const KID_RELOAD_THROTTLE_MS = 60_000;

function fetchedJwks(url: string, now: () => number = Date.now) {
  let cached: { at: number; set: ReturnType<typeof createLocalJWKSet>; kids: Set<string> } | null = null;
  let lastReload = 0;
  const load = async () => {
    // Uncompressed, please; and if a gzip body arrives undecoded anyway (seen inside the API process
    // on Cloud Run, where the global fetch is replaced), decompress it here.
    const res = await fetch(url, { headers: { accept: "application/json", "accept-encoding": "identity" } });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
    if (!res.ok) throw new Error(`IAP keys: HTTP ${res.status}`);
    let body: JSONWebKeySet;
    try {
      body = JSON.parse(text) as JSONWebKeySet;
    } catch {
      throw new Error(`IAP keys are not JSON (HTTP ${res.status}, ${res.headers.get("content-type") ?? "no type"}): ${text.slice(0, 80)}`);
    }
    cached = { at: now(), set: createLocalJWKSet(body), kids: new Set(body.keys.map((k) => k.kid ?? "")) };
    lastReload = now();
    return cached;
  };
  return async (header: { kid?: string }, token: unknown) => {
    let c = cached as typeof cached;
    const stale = c !== null && now() - c.at > 3_600_000;
    const unknownKid = header.kid !== undefined && (c === null || !c.kids.has(header.kid));
    const throttled = now() - lastReload < KID_RELOAD_THROTTLE_MS;
    if (c === null || stale || (unknownKid && !throttled)) c = await load();
    return c.set(header as never, token as never);
  };
}
