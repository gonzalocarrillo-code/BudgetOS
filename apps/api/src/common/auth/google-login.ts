import { randomBytes } from "node:crypto";
import { DomainError } from "@budget/domain";
import { SignJWT, createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { VerifiedIdentity } from "./jwt-verifier.js";

/**
 * Sign in with Google, done by Budget OS itself (ADR-067): any Google account, inside DEPT or not.
 * The app then decides who gets in, by its own users and roles, as for every other sign-in.
 *
 * GET /auth/login?next= → Google (OpenID Connect, code flow) → GET /auth/callback → a session
 * cookie → back to `next`. GET /auth/logout clears it. The session is an HS256 JWT signed with
 * SESSION_KEY (Secret Manager), HttpOnly, Secure, SameSite=Lax, for 7 days.
 */
export const SESSION_COOKIE = "budgetos_session";
const STATE_COOKIE = "budgetos_oauth";
const ISSUER = "budget-os";
const AUDIENCE = "budget-os-web";
const SESSION_TTL_S = 7 * 86_400;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface GoogleLoginConfig {
  clientId: string;
  clientSecret: string;
  sessionKey: string;
  /** The app's public origin; the callback is `${baseUrl}/auth/callback`. */
  baseUrl: string;
}

export function googleLoginFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleLoginConfig | null {
  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const sessionKey = env["SESSION_KEY"];
  const baseUrl = (env["APP_BASE_URL"] ?? "").replace(/\/$/, "");
  if (!clientId || !clientSecret || !sessionKey || !baseUrl) return null;
  if (sessionKey.length < 32) throw new Error("SESSION_KEY must be at least 32 characters");
  return { clientId, clientSecret, sessionKey, baseUrl };
}

const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** Reads one cookie from a Cookie header. */
export function cookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : (header ?? "");
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Only a path inside the app, never another site. Rejects absolute URLs, backslash-based redirects, and encoded variants. */
export const safeNext = (next: string | undefined): string => {
  if (!next || !next.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(next, "https://budget.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://budget.invalid" || !url.pathname.startsWith("/")) return "/";
  if (next.includes("\\") || /%5c/i.test(next)) return "/";
  return url.pathname + url.search + url.hash;
};

/** Step 1: to Google, with a state bound to a cookie of this browser (login CSRF). */
export async function loginRedirect(config: GoogleLoginConfig, next: string | undefined): Promise<{ location: string; setCookie: string }> {
  const nonce = randomBytes(18).toString("base64url");
  const state = await new SignJWT({ typ: "state", nonce, next: safeNext(next) }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("10m").sign(keyOf(config.sessionKey));
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");
  return { location: url.toString(), setCookie: setCookie(STATE_COOKIE, nonce, 600) };
}

/** Step 2: Google's code for an ID token, checked, then a session cookie. */
export async function loginCallback(config: GoogleLoginConfig, query: { code?: string; state?: string; error?: string }, cookieHeader: string | string[] | undefined, fetchImpl: typeof fetch = fetch, jwks: Parameters<typeof jwtVerify>[1] = GOOGLE_JWKS): Promise<{ location: string; setCookies: string[] }> {
  if (query.error || !query.code || !query.state) throw new DomainError("UNAUTHENTICATED", query.error ? `Google sign-in: ${query.error}` : "Missing code or state");
  let state: { nonce?: unknown; next?: unknown; typ?: unknown };
  try {
    ({ payload: state } = await jwtVerify(query.state, keyOf(config.sessionKey), { issuer: ISSUER, algorithms: ["HS256"] }));
  } catch {
    throw new DomainError("UNAUTHENTICATED", "Sign-in expired: start again");
  }
  if (state.typ !== "state" || state.nonce !== cookie(cookieHeader, STATE_COOKIE)) throw new DomainError("UNAUTHENTICATED", "Sign-in started in another browser: start again");
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept-encoding": "identity" },
    body: new URLSearchParams({ code: query.code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${config.baseUrl}/auth/callback`, grant_type: "authorization_code" }).toString(),
  });
  const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !tokens.id_token) throw new DomainError("UNAUTHENTICATED", `Google refused the sign-in${tokens.error ? `: ${tokens.error}` : ""}`);
  const { payload } = await jwtVerify(tokens.id_token, jwks as never, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: config.clientId });
  if (payload["nonce"] !== state.nonce) throw new DomainError("UNAUTHENTICATED", "Sign-in did not match: start again");
  const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : null;
  if (!email || payload["email_verified"] !== true || !payload.sub) throw new DomainError("UNAUTHENTICATED", "Your Google account has no verified email");
  const name = typeof payload["name"] === "string" ? payload["name"] : email;
  const session = await new SignJWT({ typ: "session", email, googleSub: payload.sub, name }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(`accounts.google.com:${payload.sub}`).setIssuedAt().setExpirationTime(`${SESSION_TTL_S}s`).sign(keyOf(config.sessionKey));
  return { location: safeNext(typeof state.next === "string" ? state.next : undefined), setCookies: [setCookie(SESSION_COOKIE, session, SESSION_TTL_S), setCookie(STATE_COOKIE, "", 0)] };
}

export const logoutCookie = () => setCookie(SESSION_COOKIE, "", 0);

/** The API's verifier in session mode: the session cookie, as the identity authenticate() expects. */
export async function verifySession(sessionKey: string, token: string): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(token, keyOf(sessionKey), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (payload["typ"] !== "session") throw new Error("not a session");
    const email = String(payload["email"] ?? "").toLowerCase();
    const googleSub = String(payload["googleSub"] ?? "");
    if (!email || !googleSub) throw new Error("incomplete session");
    return { sub: `accounts.google.com:${googleSub}`, email, emailVerified: true, googleSub };
  } catch (error) {
    throw new DomainError("UNAUTHENTICATED", "Session expired: sign in again", { reason: error instanceof errors.JOSEError ? error.code : "ERR_SESSION" });
  }
}
