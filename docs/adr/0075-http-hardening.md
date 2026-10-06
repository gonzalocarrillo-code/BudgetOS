# ADR 0075: HTTP hardening (headers, CSRF, scoped form parser, rate limits)

## Status

Accepted

## Context

W2-2, audit S-6/S-16/S-17/S-20. `apps/api` had no security headers (no CSP, HSTS, X-Frame-Options
equivalent, Referrer-Policy), no rate limiting anywhere (`/auth/*`, the MCP OAuth endpoints, search,
the two OpenAI-backed source routes), `GET /auth/logout` was a state-changing GET, the
`application/x-www-form-urlencoded` content-type parser (added for Slack's signed webhooks) was
registered globally so any JSON write route also accepted a plain HTML form body, and CSRF defence
relied solely on `SameSite=Lax`. Separately, baselines' write routes declared the generic
`workspace.member` permission and relied only on an in-service check (`assertMayManage`), so the
permission-matrix test could not catch a regression there; MCP's `export_csv` shared the general
120/min budget despite writing a GCS object per call; and an IAP assertion with an unrecognized
`kid` triggered an upstream JWKS fetch on every request that carried one.

## Decision

**Headers.** `@fastify/helmet` registered in `apps/api/src/configure-app.ts` (shared by the real
server and the test harness) with a CSP built for what the SPA actually needs:
`default-src/script-src 'self'` (the one inline script in `index.html` moved to
`apps/web/public/theme-init.js` so no `'unsafe-inline'` or hash is needed for scripts),
`style-src 'self' 'unsafe-inline'` (Tailwind/Radix/the Glide grid set inline `style="…"`
attributes at runtime), `img-src 'self' data: blob:`, `font-src 'self' data:`,
`connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self' https://accounts.google.com`; HSTS (1 year, `includeSubDomains`);
`Referrer-Policy: strict-origin-when-cross-origin`; `X-Content-Type-Options: nosniff` (helmet's
default). `apps/mcp/src/http.ts` gets the same non-CSP headers plus its own CSP
(`default-src 'none'`): it never renders HTML — the OAuth consent page is
`apps/api/src/serve-web.ts`'s `/oauth/authorize`, served by the app, not by MCP.

**Form parser scoped to Slack.** Fastify content-type parsers cannot be registered for a path
prefix, so the parser stays global (Slack's signature check needs the raw body preserved) and an
`onRequest` hook in `configure-app.ts` refuses a form-encoded body with 415 for any route outside
`/api/v1/slack/*`, before the body is parsed.

**CSRF in session mode.** The same `onRequest` hook, when `AUTH_MODE=session`: a non-GET/HEAD/
OPTIONS request under `/api/v1/*` or `/auth/*` needs `Sec-Fetch-Site` of `same-origin`/`none`, or
— when that header is absent — an `Origin` matching `APP_BASE_URL`; otherwise 403
`{code:"FORBIDDEN"}`. `/api/v1/slack/*` is exempt (protected by its own signature instead); the MCP
server's `/oauth/token` and `/oauth/register` are public-client endpoints on a different server
entirely (no cookie, so nothing for a cross-site page to ride) and were never in scope. Bearer-token
auth modes (`identity-platform`, `iap`) are not cookie sessions, so the check is inert there.

**Logout is POST.** `POST /auth/logout` (session mode) does what `GET /auth/logout` used to; the
`GET` route now answers 405 instead of quietly "working" from a stray link or prefetch. The web's
`signOut()` (`apps/web/src/lib/auth.ts`) now `fetch`es that POST (`credentials: "include"`) before
navigating to `/` — the CSRF check is satisfied for free, because a same-origin `fetch` always
carries a browser-set `Sec-Fetch-Site: same-origin` the page cannot override.

**Rate limiting.** `@fastify/rate-limit`, by IP, on `/auth/*` (20/min, `apps/api/src/serve-web.ts`)
and the MCP server's `/oauth/register` and `/oauth/token` (30/min, `apps/mcp/src/http.ts`); Cloud
Run's `K_SERVICE` env var gates `trustProxy` on the Fastify adapter in both services' `main.ts`, so
`request.ip` (the rate limiter's default key) is the real caller there and the loopback address
everywhere else.

Per-user limits (search/suggest at 120/min, the two OpenAI-backed source routes at 10/min) are
**not** `@fastify/rate-limit`, by design: that plugin's own hook runs before NestJS resolves the
tenant (`request.tenant` only exists after `TenantInterceptor` authenticates the caller), so there
is no user id to key on at the point the plugin would need one. Instead, `RateLimitInterceptor`
(`apps/api/src/common/rate-limit.interceptor.ts`) is a second global interceptor, registered right
after `TenantInterceptor` in `common.module.ts` so it runs after tenant resolution in the same
request; it reads an optional `@RateLimit(scope, max)` method decorator
(`rate-limit.decorator.ts`) and throws `DomainError("RATE_LIMITED", …)` — the same error type (and
`DomainExceptionFilter` mapping to 429) every other write path already uses, and the same
in-memory-per-instance tradeoff MCP's own limiter (`apps/mcp/src/rate-limit.ts`) already accepts
(D-2 in the hardening plan: Memorystore is a later decision). `@fastify/rate-limit`'s own thrown
error is a plain object, which NestJS's global Fastify error handler only turns into the right HTTP
status for a real `FastifyError`; the raw (non-Nest) `/auth/*` routes register their own
`setErrorHandler` (`rateLimitErrorHandler`, exported from `configure-app.ts`) inside an encapsulated
Fastify scope so a 429 stays a 429 instead of a generic 500.

MCP's `export_csv` gets its own, stricter, separately-tracked 10/min budget
(`EXPORT_CALLS_PER_MINUTE` in `apps/mcp/src/rate-limit.ts`) independent of the general 120/min —
`RateLimiter.take(userId, scope?)` now takes an optional scope, defaulting to the general budget.

**Baselines permission (S-16).** A new `baseline.save` action in `packages/domain/src/
permissions.ts`, granted to the same roles `assertMayManage` already allows in practice —
`closure.close` holders (FINANCE, WORKSPACE_ADMIN, ORG_ADMIN) and `envelope.edit_draft` holders
(PLANNER, BUDGET_OWNER) — replacing `workspace.member` on `POST /workspaces/:ws/baselines` and
`PATCH /baselines/:id`. The in-service scope check (the whole-workspace case needs `closure.close`
specifically, not just any `envelope.edit_draft` grant) stays; the route permission is now a floor
the permission-matrix test enforces, not just a ceiling the service happens to narrow.

**JWKS refetch throttle (S-20).** `fetchedJwks` in `apps/api/src/common/auth/jwt-verifier.ts` still
refetches at once for an unrecognized `kid` (a key may have just rotated), but no more than once
per 60 seconds; a burst of requests carrying a `kid` the cache never resolves (a stale cache, or
probing) costs one upstream fetch, not one per request.

## Consequences

- A production `AUTH_MODE=session` deployment now rejects any non-GET `/api/v1/*` or `/auth/*`
  request a browser did not originate same-origin; an integration that posts to the API with its
  own `Origin` header and no cookie (there should be none, since session auth is cookie-only) is
  unaffected.
- `RateLimitInterceptor`'s counters reset on a deploy/restart and are per-instance, same as MCP's;
  revisit together with D-2 if Memorystore is adopted.
- The CSP is intentionally strict (no `'unsafe-eval'`, no third-party script/style/connect hosts);
  a future dependency that needs one of those must extend `CSP_DIRECTIVES` in `configure-app.ts`
  with a comment explaining why, per AGENTS.md's own convention for CSP relaxations.
- `configureApp` and `buildHttp` (apps/mcp) are now `async` (they `await` their own plugin
  registrations, so a route's `config.rateLimit` is guaranteed to take effect); every caller
  (`main.ts`, the test harnesses) awaits them.
