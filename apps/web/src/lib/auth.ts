/**
 * Where the SPA keeps the caller's Identity Platform ID token (spec §4). Signing in with Google
 * Workspace through Identity Platform is connected in the GCP phase; until then the sign-in page
 * takes a token (Playwright mints a real, signed one). The API verifies every request: there is
 * no auth bypass here. sessionStorage: the token is a credential for this tab, not app data.
 */
const KEY = "budget-os.idToken";
const SIGNED_OUT = "budget-os.signedOut";
const listeners = new Set<() => void>();

/**
 * The persistent local stack (`pnpm dev:local`) passes a long-lived admin token to the Vite dev
 * server as VITE_DEV_ID_TOKEN; a dev build uses it until the user signs out in this tab. Production
 * builds never have it (it is set only by that script), and the API still verifies it.
 */
const env = (import.meta as { env?: { DEV?: boolean; VITE_DEV_ID_TOKEN?: string; VITE_AUTH_MODE?: string } }).env;
const devToken = env?.DEV && env.VITE_DEV_ID_TOKEN ? env.VITE_DEV_ID_TOKEN : null;

/**
 * ADR-065: deployed behind Identity-Aware Proxy (a build with VITE_AUTH_MODE=iap). Google sign-in
 * happens before the page loads and IAP vouches for every request, so there is no token to hold:
 * the SPA is always signed in, sends no Authorization header, and signing out clears IAP's cookie.
 */
export const IAP = env?.VITE_AUTH_MODE === "iap";
export const IAP_SESSION = "iap";

/**
 * ADR-067: Budget OS's own Google sign-in (a build with VITE_AUTH_MODE=session). The session is an
 * HttpOnly cookie the page cannot read: it counts as signed in until the API answers 401, then shows
 * the sign-in page, whose button starts /auth/login. Sign out clears the cookie on the server.
 */
export const SESSION = env?.VITE_AUTH_MODE === "session";
let signedOut = false;

/** Whether requests carry a cookie instead of a bearer token (IAP or the session). */
export const COOKIE_AUTH = IAP || SESSION;

export function getToken(): string | null {
  if (IAP) return IAP_SESSION;
  if (SESSION) return signedOut ? null : "session";
  try {
    return sessionStorage.getItem(KEY) ?? (devToken && sessionStorage.getItem(SIGNED_OUT) === null ? devToken : null);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  sessionStorage.removeItem(SIGNED_OUT);
  sessionStorage.setItem(KEY, token.trim());
  listeners.forEach((l) => l());
}

export function clearToken(): void {
  if (SESSION) {
    signedOut = true;
    listeners.forEach((l) => l());
    return;
  }
  if (IAP) {
    window.location.assign("/?gcp-iap-mode=CLEAR_LOGIN_COOKIE");
    return;
  }
  sessionStorage.removeItem(KEY);
  if (devToken) sessionStorage.setItem(SIGNED_OUT, "1");
  listeners.forEach((l) => l());
}

/** The person's Sign out: the session ends on the server (session mode), else the token goes. */
export function signOut(): void {
  if (SESSION) {
    // S-6: logout is a state change, so it is POST, not a GET navigation; the browser's own
    // Sec-Fetch-Site: same-origin on this fetch is what the server's CSRF check requires.
    fetch("/auth/logout", { method: "POST", credentials: "include" }).finally(() => window.location.assign("/"));
    return;
  }
  clearToken();
}

/**
 * ADR-067 addendum (W5-3, audit S-11): ends every session of this account, not only this one —
 * session mode only (IAP and the dev token have no server-side session store to revoke).
 */
export function signOutEverywhere(): void {
  if (!SESSION) return;
  fetch("/auth/logout-all", { method: "POST", credentials: "include" }).finally(() => window.location.assign("/"));
}

export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
