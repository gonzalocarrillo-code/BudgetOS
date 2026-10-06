# ADR-066: The MCP server signs people in with OAuth, through the app's Google sign-in

## Status
Accepted (product owner, 2026-09-29: "make sure the MCP is live with OAuth").

## Context
MCP clients (Claude, the MCP Inspector, IDEs) implement the MCP authorization spec: a 401 names the resource metadata, then come authorization-server discovery, dynamic client registration and the authorization code flow with PKCE. People already sign in to Budget OS with Google through IAP (ADR-065). Google's own OAuth server does not accept dynamic client registration.

## Decision
- **`budgetos-mcp` is public, and is both the protected resource and its own authorization server.** It serves `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `POST /oauth/register` and `POST /oauth/token` (authorization code with S256 PKCE, and refresh).
- **The authorization endpoint is `budgetos-app/oauth/authorize`, behind IAP.** The person signs in with Google as for the app and sees a consent page (the client's name and where they go back to); Allow sends a 5-minute code to the client's registered redirect URI. The Allow link is signed for that person and that request, so it cannot be forged cross-site.
- **Stateless.** Client ids, consent links, codes, access tokens (1 hour, audience `budget-os-mcp`) and refresh tokens (30 days) are HS256 JWTs signed with `MCP_OAUTH_KEY` (secret `budgetos-mcp-oauth-key`). Each carries its kind, so one is never accepted as another; codes and refresh tokens are bound to the client.
- **Authorization is unchanged.** The token names a Google account; the MCP server runs the same `authenticate()`: an active app user, their roles, read-only tools (`budget_mcp` role), and every call audited.
- Redirect URIs must be https, or http on localhost.

## Consequences
- Rotating the key signs every MCP client out; they sign in again.
- A code can be replayed within its 5 minutes, but only by the client that holds its PKCE verifier.

## Addendum (2026-10-06, W5-3, audit S-12): single-use codes, rotating refresh tokens

The JWTs alone made a code replayable within its 5 minutes (by whoever also had its PKCE verifier) and let a refresh token be used over and over for its full 30-day life with no way to tell a legitimate use from a stolen one. Fixed with a small server-side record (migration 20261011000000, `packages/db`'s `oauth-store.ts`), on top of the JWTs rather than instead of them:

- **`oauth_code`**: a code is now consumed exactly once (`app_issue_code` on the api side when `oauth.consent()`/`code()` mint it; `app_consume_code` on the MCP side when `/oauth/token` exchanges it) — keyed by a hash of the code, never the code itself.
- **`oauth_refresh`**: every refresh token carries a `jti`. Each use *rotates* it (`app_issue_refresh`/`app_consume_refresh`, both MCP-side, where `/oauth/token` runs): the old one is marked used and a new one issued in its place. A consumed token used again — a replay, meaning it was stolen — revokes every token in that `(user, client)` chain at once, not just the one replayed. A chain's absolute lifetime is 90 days from its first issuance (the code exchange), independent of how many times it has rotated since.
- **Grant now carries `userId`** (the app_user id), resolved once at `/oauth/authorize` (`AccessRepository.findUser`) and carried through every code/token JWT after that — exchange and refresh never need their own app_user lookup, and an unprovisioned Google account is refused at the consent page instead of receiving tokens it could never use.
- **Grants, by role** (same migration): `budget_app` gets EXECUTE on `app_issue_code` only; `budget_mcp` gets EXECUTE on `app_consume_code`, `app_issue_refresh`, `app_consume_refresh` only (`apps/mcp/src/import-guard.test.ts`'s `DB_ALLOWED` names exactly these three — nothing else from `@budget/db` is reachable from `apps/mcp/src`, the same read-only invariant as every tool). Neither table has any other grant: every access goes through these RPCs.
- `McpOAuth`'s `OAuthStore` is optional — without one (as the existing unit tests still construct it), codes and refresh tokens behave exactly as before this addendum.
