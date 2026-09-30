import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./api.gen.js";
import { COOKIE_AUTH, IAP, clearToken, getToken } from "./auth.js";

/**
 * Typed API client generated from apps/api/openapi.json (`pnpm --filter @budget/web api:generate`,
 * kept current by src/lib/api.gen.test.ts). Adds the bearer token; a 401 signs the tab out.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = COOKIE_AUTH ? null : getToken();
    if (token) request.headers.set("authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ response }) {
    // Behind IAP a 401 means the session ended: reload, and IAP signs in again.
    if (response.status === 401) {
      if (IAP) {
        // Once per 30 s at most: a reload signs in again; a second 401 right after is a real error.
        const last = Number(sessionStorage.getItem("budget-os.iapReload") ?? 0);
        if (Date.now() - last > 30_000) {
          sessionStorage.setItem("budget-os.iapReload", String(Date.now()));
          window.location.reload();
        }
      }
      else clearToken();
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: typeof window === "undefined" ? "http://localhost" : window.location.origin });
api.use(auth);

/** Unwraps an openapi-fetch result: the data, or an ApiError with the API's error code. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (response.ok) return data as T;
  const e = (error ?? {}) as { code?: string; message?: string };
  throw new ApiError(response.status, e.code ?? String(response.status), e.message ?? response.statusText);
}
