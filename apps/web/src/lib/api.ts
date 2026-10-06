import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./api.gen.js";
import { COOKIE_AUTH, IAP, clearToken, getToken } from "./auth.js";

/**
 * Typed API client generated from apps/api/openapi.json (`pnpm --filter @budget/web api:generate`,
 * kept current by src/lib/api.gen.test.ts). Adds the bearer token; a 401 signs the tab out; every
 * mutation carries an Idempotency-Key (idempotentFetch).
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Worth one retry: the API's own "database busy; retry" (503) and a load-balancer hiccup. */
const RETRY_STATUSES = new Set([502, 503, 504]);

export interface IdempotentFetchOptions {
  fetch?: (request: Request) => Promise<Response>;
  newKey?: () => string;
  retryDelayMs?: number;
}

/**
 * W3-2 (spec §17, ADR-0081): every mutating call carries a fresh `Idempotency-Key`, and the one
 * retry this client makes — after a network failure or a 502/503/504 — reuses it, so a change
 * whose first attempt did land is answered from the API's stored response instead of being made
 * twice. Reads are sent as they are, never retried here (TanStack Query retries those).
 */
export async function idempotentFetch(request: Request, opts: IdempotentFetchOptions = {}): Promise<Response> {
  const send = opts.fetch ?? ((r: Request) => globalThis.fetch(r));
  if (SAFE_METHODS.has(request.method.toUpperCase())) return send(request);
  if (!request.headers.has("idempotency-key")) request.headers.set("idempotency-key", (opts.newKey ?? (() => crypto.randomUUID()))());
  const retry = request.clone();
  try {
    const first = await send(request);
    if (!RETRY_STATUSES.has(first.status)) return first;
  } catch (error) {
    // The caller gave up (navigated away, cancelled): not a failure to retry.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 500));
  return send(retry);
}

export const api = createClient<paths>({ baseUrl: typeof window === "undefined" ? "http://localhost" : window.location.origin, fetch: (request) => idempotentFetch(request) });
api.use(auth);

/** Unwraps an openapi-fetch result: the data, or an ApiError with the API's error code. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (response.ok) return data as T;
  const e = (error ?? {}) as { code?: string; message?: string };
  throw new ApiError(response.status, e.code ?? String(response.status), e.message ?? response.statusText);
}
