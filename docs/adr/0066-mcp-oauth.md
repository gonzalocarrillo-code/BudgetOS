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
