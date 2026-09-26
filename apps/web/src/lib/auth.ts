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
const env = (import.meta as { env?: { DEV?: boolean; VITE_DEV_ID_TOKEN?: string } }).env;
const devToken = env?.DEV && env.VITE_DEV_ID_TOKEN ? env.VITE_DEV_ID_TOKEN : null;

export function getToken(): string | null {
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
  sessionStorage.removeItem(KEY);
  if (devToken) sessionStorage.setItem(SIGNED_OUT, "1");
  listeners.forEach((l) => l());
}

export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
