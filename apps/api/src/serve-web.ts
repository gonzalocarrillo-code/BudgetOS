import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { rateLimitErrorHandler } from "./configure-app.js";
import { JwtVerifier } from "./common/auth/jwt-verifier.js";
import { McpOAuth } from "./common/auth/mcp-oauth.js";
import { SESSION_COOKIE, cookie, googleLoginFromEnv, loginCallback, loginRedirect, logoutCookie, verifySession } from "./common/auth/google-login.js";

/**
 * Deployed hosting (ADR-065). WEB_DIST: the API also serves the built SPA, so the web and the API
 * share one origin behind IAP (no CORS, one sign-in); a path outside /api that is not a file gets
 * index.html (client-side routes). PUBLIC_ROUTES=slack: the public service answers only the signed
 * Slack routes and /health (Cloud Run reserves /healthz); everything else is 404, so nothing but Slack's callbacks is reachable
 * without IAP.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function serveWeb(app: NestFastifyApplication, env: NodeJS.ProcessEnv = process.env): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.get("/health", async (_req, reply) => reply.send("ok"));
  if (env["PUBLIC_ROUTES"] === "slack") {
    fastify.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      if (path !== "/health" && !path.startsWith("/api/v1/slack/")) await reply.code(404).send({ code: "NOT_FOUND", message: "Not found" });
    });
    return;
  }
  // ADR-067: Budget OS's own Google sign-in (AUTH_MODE=session).
  const google = env["AUTH_MODE"] === "session" ? googleLoginFromEnv(env) : null;
  if (google) {
    // S-6: an encapsulated scope so its own `setErrorHandler` (not Nest's, which only recognizes a
    // real `FastifyError`) formats the rate limiter's thrown error — by IP, 20/min, since these are
    // the routes a credential-stuffing or sign-in-flood script hits.
    void fastify.register(async (scope) => {
      scope.setErrorHandler(rateLimitErrorHandler);
      const authRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
      scope.get("/auth/login", authRateLimit, async (req, reply) => {
        const r = await loginRedirect(google, (req.query as { next?: string }).next);
        return reply.header("set-cookie", r.setCookie).header("cache-control", "no-store").redirect(r.location, 302);
      });
      scope.get("/auth/callback", authRateLimit, async (req, reply) => {
        try {
          const r = await loginCallback(google, req.query as { code?: string; state?: string; error?: string }, req.headers.cookie);
          return reply.header("set-cookie", r.setCookies).header("cache-control", "no-store").redirect(r.location, 302);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return reply.header("cache-control", "no-store").redirect(`/?login_error=${encodeURIComponent(message)}`, 302);
        }
      });
      // Who the session names, without the database: the "not added yet" page says which account.
      scope.get("/auth/me", authRateLimit, async (req, reply) => {
        const token = cookie(req.headers.cookie, SESSION_COOKIE);
        const who = token ? await verifySession(google.sessionKey, token).catch(() => null) : null;
        return reply.header("cache-control", "no-store").send(who ? { email: who.email } : { email: null });
      });
      // S-6: logout is a state change (it ends the session), so it is POST; a GET is refused rather
      // than silently doing nothing, so an old link or bookmark fails loudly instead of looking like
      // it worked.
      scope.post("/auth/logout", authRateLimit, async (_req, reply) => reply.header("set-cookie", logoutCookie()).header("cache-control", "no-store").redirect("/", 302));
      scope.get("/auth/logout", async (_req, reply) => reply.code(405).header("allow", "POST").send({ code: "VALIDATION", message: "Sign out with POST /auth/logout" }));
    });
  }
  // ADR-066: the MCP OAuth authorization endpoint, signed in like the rest of the app.
  const oauth = McpOAuth.fromEnv(env);
  if (oauth && (env["AUTH_MODE"] === "iap" || env["AUTH_MODE"] === "session")) {
    const verifier = new JwtVerifier();
    fastify.get("/oauth/authorize", async (req, reply) => authorizePage(oauth, verifier, req as unknown as Req, reply as unknown as Reply));
  }
  const dist = env["WEB_DIST"];
  if (!dist) return;
  const root = normalize(dist);
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const path = decodeURIComponent(req.url.split("?")[0] ?? "/");
    if (path.startsWith("/api/") || path.startsWith("/auth/") || path === "/health" || path === "/oauth/authorize") return;
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) return reply.code(404).send();
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile) file = join(root, "index.html");
    const hashed = file.includes(`${root}/assets/`);
    return reply
      .header("content-type", TYPES[extname(file)] ?? "application/octet-stream")
      .header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await readFile(file));
  });
}

/** What the authorize page uses of Fastify's request and reply (the API has no direct fastify dependency). */
interface Req {
  url?: string;
  query: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Reply {
  code(status: number): Reply;
  type(contentType: string): Reply;
  header(name: string, value: string): Reply;
  send(body: string): unknown;
  redirect(url: string, status: number): unknown;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Budget OS</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f0f4f8;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;max-width:440px;margin:16px}h1{font-size:20px;margin:0 0 8px}
.muted{color:#64748b;font-size:13px}.row{display:flex;gap:10px;margin-top:20px}a.btn{padding:9px 16px;border-radius:9px;text-decoration:none;font-weight:600}
.primary{background:#2563eb;color:#fff}.ghost{border:1px solid #cbd5e1;color:#0f172a}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}main{background:#111a2e;border-color:#1e293b}.ghost{color:#e2e8f0;border-color:#334155}}</style></head>
<body><main>${body}</main></body></html>`;

/**
 * GET /oauth/authorize (RFC 6749 with PKCE): the person is signed in by IAP. Without `approve`,
 * a consent page; with a valid `approve` (signed for this person and this exact request), a code
 * to the client's registered redirect URI.
 */
async function authorizePage(oauth: McpOAuth, verifier: JwtVerifier, req: Req, reply: Reply) {
  const q = req.query as Record<string, string | undefined>;
  const fail = (message: string) => reply.code(400).type("text/html; charset=utf-8").send(page("Cannot connect", `<h1>Cannot connect</h1><p>${esc(message)}</p>`));
  let identity;
  try {
    identity = await verifier.verify(verifier.credential(req.headers));
  } catch {
    // Signed out: sign in with Google, then come back to this same authorization request.
    if (process.env["AUTH_MODE"] === "session") return reply.redirect(`/auth/login?next=${encodeURIComponent(req.url ?? "/")}`, 302);
    return reply.code(401).type("text/html; charset=utf-8").send(page("Sign in", "<h1>Sign in first</h1><p>Reload this page to sign in with Google.</p>"));
  }
  const grant = { email: identity.email, googleSub: identity.googleSub ?? identity.sub };
  if (q["approve"]) {
    const { grant: signedFor, request } = await oauth.readConsent(q["approve"]).catch(() => ({ grant: null, request: {} as Record<string, string> }));
    if (!signedFor || signedFor.email !== grant.email) return fail("This approval link is not yours or has expired. Start again from your MCP client.");
    const code = await oauth.code(grant, { clientId: request["client_id"] ?? "", redirectUri: request["redirect_uri"] ?? "", codeChallenge: request["code_challenge"] ?? "" });
    const to = new URL(request["redirect_uri"] ?? "");
    to.searchParams.set("code", code);
    if (request["state"]) to.searchParams.set("state", request["state"]);
    return reply.redirect(to.toString(), 302);
  }
  const clientId = q["client_id"] ?? "";
  const redirectUri = q["redirect_uri"] ?? "";
  if (q["response_type"] !== "code") return fail("Only response_type=code is supported.");
  if (!q["code_challenge"] || (q["code_challenge_method"] ?? "S256") !== "S256") return fail("PKCE with S256 is required.");
  const client = await oauth.client(clientId).catch(() => null);
  if (!client) return fail("Unknown client. Register it again from your MCP client.");
  if (!client.redirectUris.includes(redirectUri)) return fail("This redirect URI was not registered by the client.");
  const request: Record<string, string> = { client_id: clientId, redirect_uri: redirectUri, code_challenge: q["code_challenge"], ...(q["state"] ? { state: q["state"] } : {}) };
  const approve = await oauth.consent(grant, request);
  const allow = `/oauth/authorize?approve=${encodeURIComponent(approve)}`;
  const host = new URL(redirectUri).host;
  return reply
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      page(
        "Connect",
        `<h1>Allow ${esc(client.name)} to read Budget OS?</h1><p>It will read budgets, spend, approvals and alerts that you can see, as <b>${esc(grant.email)}</b>. It cannot change anything.</p><p class="muted">After you allow it, you go back to ${esc(host)}.</p><div class="row"><a class="btn primary" href="${esc(allow)}">Allow</a><a class="btn ghost" href="/">Cancel</a></div>`,
      ),
    );
}
