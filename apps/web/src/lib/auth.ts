/**
 * Where the SPA keeps the caller's Identity Platform ID token (spec §4). Signing in with Google
 * Workspace through Identity Platform is connected in the GCP phase; until then the sign-in page
 * takes a token (Playwright mints a real, signed one). The API verifies every request: there is
 * no auth bypass here. sessionStorage: the token is a credential for this tab, not app data.
 */
const KEY = "budget-os.idToken";
const listeners = new Set<() => void>();

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  sessionStorage.setItem(KEY, token.trim());
  listeners.forEach((l) => l());
}

export function clearToken(): void {
  sessionStorage.removeItem(KEY);
  listeners.forEach((l) => l());
}

export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
