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
