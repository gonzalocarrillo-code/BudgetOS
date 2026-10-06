# ADR-067: Budget OS signs people in with Google itself

## Status
Accepted (product owner, 2026-09-30: "accessible by anyone, and use OAuth as login, both in and outside deptagency.com"). Supersedes ADR-065's use of IAP for signing in; the rest of ADR-065 stands.

## Context
Cloud Run's built-in IAP uses a Google-managed OAuth client that admits only accounts of the project's organization, and each person also needs an IAM grant. People outside DEPT (a client, a Gmail account) cannot get past it. The owner also wants a Budget OS login page, not Google's IAP screen.

## Decision
- **`budgetos-app` is public.** The app runs OpenID Connect with Google itself:
  - `/auth/login` sends the browser to Google, with a state bound to a cookie and a nonce;
  - `/auth/callback` exchanges the code, verifies Google's ID token (issuer, audience, nonce, verified email), and sets the session;
  - `/auth/logout` clears it.

  Any Google account can sign in.
- **The session** is an HS256 JWT (`budgetos_session`, HttpOnly, Secure, SameSite=Lax, 7 days), signed with `SESSION_KEY` (secret `budgetos-session-key`). The API runs with `AUTH_MODE=session` and reads the cookie instead of a bearer token or the IAP header.
- **Who gets in is unchanged:** an active Budget OS user whose Google account id or verified email matches, with a role. A signed-in Google account that nobody added sees "You don't have access to Budget OS yet", with its email and a way to use another account.
- **The login page** is Budget OS's ("Log in to Budget OS", Continue with Google). The MCP authorization page (ADR-066) sends signed-out people through the same login and back.
- **The Google OAuth client** (web application; redirect `https://budgetos-app-666309304754.us-central1.run.app/auth/callback`) lives in Secret Manager as `budgetos-google-oauth-client-id` and `budgetos-google-oauth-client-secret`. While the secret is empty, the deploy keeps IAP (ADR-065). Once it has a value, the deploy builds and runs session mode.

## Consequences
- IAP's IAM list no longer gates the app; the app's user list does. Adding someone is one step: Org console › People, or a workspace's Roles.
- The client is a Web application client in `dmus-gonzalo` (owner's choice, 2026-09-30), so Google's sign-in screen shows that project's consent screen name, "DEPT BrandOS". Who can sign in at Google's end (External, In production) is that shared consent screen's setting; the app admits only its own users either way.

## Addendum (2026-10-06, W5-3, audit S-11): a revocable, `__Host-` session

The session was a stateless 7-day JWT: logout only cleared the browser's cookie, so a stolen cookie, or a deactivated user's existing cookie, stayed good for up to 7 days. Fixed:

- **`auth_session`** (migration 20261011000000): one row per issued session, keyed by a `jti` now embedded in the session JWT. `loginCallback` creates it — through `app_create_session`, a SECURITY DEFINER RPC, since login runs before any tenant context exists — only for a Google account that already is a provisioned Budget OS user (`SessionSink.findUser`). An account nobody added yet still gets a plain JWT with no `jti`, exactly as before: there is nothing to revoke for an account with no access regardless, and `/auth/me` (the "not added yet" page) must keep answering from the JWT alone.
- **`verifySession`** checks `app_session_live(jti)` whenever a `jti` is present (`JwtVerifier`, cached positively for 60s per process — `LiveSessionCache` — so a revoke is visible within a minute at the cost of at most one indexed lookup per request per window).
- **`POST /auth/logout`** now revokes its own session (`app_revoke_session`) in addition to clearing the cookie. **`POST /auth/logout-all`** is new: "sign out everywhere" (`app_revoke_all_sessions`), revoking every live session of whoever the cookie's `jti` belongs to; it needs no app_user lookup, only the jti already on the cookie. Both are rate-limited and CSRF-guarded the same as `/auth/logout` (S-6).
- **The cookie is now `__Host-budgetos_session`** (Path=/, Secure, no Domain — already true of every attribute `setCookie()` sets; only the name changed), and rotates (a fresh `jti`) on every login.
- See `packages/db/prisma/migrations/20261011000000_session_and_refresh_store/migration.sql` for the exact grants: `budget_app` gets SELECT/UPDATE on `auth_session` (RLS: a session's own rows only, for a future self-service "your sessions" view); `budget_mcp`/`budget_publisher` get nothing — a session row is security data, not something the read-only reporting server should see.
