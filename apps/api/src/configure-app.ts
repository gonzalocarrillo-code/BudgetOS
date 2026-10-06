import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { RequestMethod } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * S-6: the CSP the SPA (Vite build, React 19, `@budget/grid`'s Glide canvas) actually needs.
 * - `script-src 'self'`: the only inline script in `index.html` (the pre-paint theme read) was
 *   moved to `/theme-init.js` (apps/web/public/theme-init.js) so no 'unsafe-inline' or hash is
 *   needed.
 * - `style-src 'unsafe-inline'`: Tailwind/Radix set inline `style="…"` attributes at runtime
 *   (popovers, the Glide grid's cell overlay positions); there is no practical nonce story for
 *   those, and they are attribute styles, not script.
 * - `img-src data: blob:`: workspace/dimension icons are uploaded SVGs served as `data:`/blob
 *   URLs in a few places (asset previews), alongside the API's own `/api/v1/assets/...`.
 * - `form-action https://accounts.google.com`: the sign-in page's "Continue with Google" is a
 *   plain link (`<a href>`), not a form post, but `/auth/login` 302s the browser to Google, whose
 *   own consent screen posts back to itself; this keeps that path clear if it ever becomes a form.
 */
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'", "https://accounts.google.com"],
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const pathOf = (url: string | undefined): string => (url ?? "/").split("?")[0] ?? "/";
const isSlackRoute = (path: string): boolean => path.startsWith("/api/v1/slack/");
const isGuarded = (path: string): boolean => path.startsWith("/api/v1/") || path.startsWith("/auth/");

/**
 * What the server and the test harness both set up. Slack posts form-encoded bodies and signs the
 * raw bytes (x-slack-signature), so form bodies keep their raw text next to the parsed fields —
 * every other route refuses a form body (S-6: the parser used to be accepted everywhere).
 */
export async function configureApp(app: NestFastifyApplication, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // W5-1 (audit M-7): GET /ready (common/health.controller.ts) stays unprefixed, like /health
  // (serve-web.ts), so Cloud Run's readiness probe config doesn't need the API prefix.
  app.setGlobalPrefix("api/v1", { exclude: [{ path: "ready", method: RequestMethod.GET }] });
  const fastify = app.getHttpAdapter().getInstance();

  // W5-1 (audit M-3): every response carries the request id pino logged it under, whether the
  // caller sent one (X-Request-Id echoed back) or main.ts's genReqId minted one.
  fastify.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  // S-6: headers. CSP/HSTS/Referrer-Policy/X-Content-Type-Options/frame-ancestors on every response,
  // API and (serve-web.ts) the SPA and the OAuth consent page alike.
  await fastify.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  // S-6: registered once, globally, but inert everywhere until a route opts in with its own
  // `config.rateLimit` (serve-web.ts's /auth/* routes, apps/mcp/src/http.ts's /oauth/* routes).
  // Awaited (not fire-and-forget): the plugin's `onRoute` hook — which is what makes a route's own
  // `config.rateLimit` take effect — must be attached before serve-web.ts registers those routes.
  await fastify.register(rateLimit, { global: false, errorResponseBuilder: rateLimitErrorResponseBuilder });

  // The app is created with bodyParser: false (Nest would register its own form parser); JSON is Fastify's.
  if (fastify.hasContentTypeParser("application/x-www-form-urlencoded")) fastify.removeContentTypeParser("application/x-www-form-urlencoded");
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    (request as unknown as { rawBody?: string }).rawBody = raw;
    done(null, Object.fromEntries(new URLSearchParams(raw)));
  });

  fastify.addHook("onRequest", async (request, reply) => {
    const path = pathOf(request.url);

    // S-6: the form-encoded parser above is registered globally (Fastify content-type parsers
    // cannot be scoped to a path prefix), so a route outside Slack's gets refused here instead,
    // before the body is even parsed.
    const contentType = header(request.headers, "content-type");
    if (contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded") === true && !isSlackRoute(path)) {
      await reply.code(415).send({ code: "UNSUPPORTED_MEDIA_TYPE", message: "This route does not accept a form-encoded body" });
      return;
    }

    // S-6: CSRF defence for the cookie-based session (AUTH_MODE=session). A bearer-token caller
    // (identity-platform/iap modes, and MCP, which never sends cookies) is not a browser session,
    // so there is nothing for a cross-site page to ride; Slack's routes are protected by their
    // own signature instead.
    if (env["AUTH_MODE"] === "session" && !SAFE_METHODS.has((request.method ?? "GET").toUpperCase()) && isGuarded(path) && !isSlackRoute(path)) {
      const site = header(request.headers, "sec-fetch-site");
      const sameOrigin = site === undefined ? sameAsAppBase(header(request.headers, "origin"), env["APP_BASE_URL"]) : site === "same-origin" || site === "none";
      if (!sameOrigin) {
        await reply.code(403).send({ code: "FORBIDDEN", message: "Cross-site request blocked" });
        return;
      }
    }
  });
}

function sameAsAppBase(origin: string | undefined, appBaseUrl: string | undefined): boolean {
  if (!origin || !appBaseUrl) return false;
  try {
    return new URL(origin).origin === new URL(appBaseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * `@fastify/rate-limit` throws whatever this returns (it does not call `reply.send` itself), and
 * NestJS installs its own global Fastify error handler (`registerExceptionHandler` in
 * `@nestjs/core`) that only forwards the right status code for a real `FastifyError` — a thrown
 * plain object gets a generic 500. Routes under Nest's own routing never hit this (an unhandled
 * throw there is a `DomainError`, caught by `DomainExceptionFilter`); the raw Fastify routes this
 * app also serves (serve-web.ts's `/auth/*`) need their own `setErrorHandler` — see
 * `rateLimitErrorHandler` below — that reads the `statusCode` this builder attaches.
 */
export function rateLimitErrorResponseBuilder(_request: unknown, context: { after: string; statusCode: number }): { statusCode: number; code: string; message: string } {
  return { statusCode: context.statusCode, code: "RATE_LIMITED", message: `Too many requests; retry in ${context.after}` };
}

/** A Fastify `setErrorHandler` that turns `rateLimitErrorResponseBuilder`'s throw into a reply. */
export function rateLimitErrorHandler(err: unknown, _request: unknown, reply: { code(status: number): { send(body: unknown): unknown } }): unknown {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : 500;
  return reply.code(statusCode).send({ code: e.code ?? "INTERNAL", message: e.message ?? "Internal error" });
}
