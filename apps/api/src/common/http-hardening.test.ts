import { describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-support/harness.js";

/**
 * S-6 done-when: security headers, the form parser scoped to Slack, and the session-mode CSRF
 * check. `AUTH_MODE` here only steers `configureApp`'s own CSRF guard (`configureAppEnv`, see
 * test-support/harness.ts) — the harness's JwtVerifier stays in its usual identity-platform mode,
 * so minted tokens keep working for the "same-origin passes" case.
 */
describe("security headers (S-6)", () => {
  it("sets CSP, HSTS, X-Content-Type-Options and Referrer-Policy on the API and on an unmatched path", async () => {
    const h = await startHarness();
    try {
      const token = await h.mint({ sub: "ip-headers", email: "headers@planner.test" });
      const api = await h.call("GET", "/api/v1/me", token);
      const root = await h.call("GET", "/", null);
      for (const res of [api, root]) {
        expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
        expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
        expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      }
    } finally {
      await h.close();
    }
  });
});

describe("form parser scoped to Slack (S-6)", () => {
  it("refuses a form-encoded body on a JSON route with 415", async () => {
    const h = await startHarness();
    try {
      const token = await h.mint({ sub: "ip-415", email: "form415@planner.test" });
      const res = await h.call("PATCH", "/api/v1/me", token, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=anything" });
      expect(res.status).toBe(415);
      expect(res.body).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    } finally {
      await h.close();
    }
  });

  it("still accepts a form-encoded body under /api/v1/slack/ (signature checked separately)", async () => {
    const h = await startHarness();
    try {
      const res = await h.call("POST", "/api/v1/slack/commands", null, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=help" });
      // Refused for lacking a valid Slack signature, never for the content type.
      expect(res.status).not.toBe(415);
    } finally {
      await h.close();
    }
  });
});

describe("CSRF defence in session mode (S-6)", () => {
  it("blocks a cross-site non-GET request", async () => {
    const h: Harness = await startHarness({ configureAppEnv: { AUTH_MODE: "session", APP_BASE_URL: "https://budgetos.example" } });
    try {
      const token = await h.mint({ sub: "ip-csrf-x", email: "csrf-cross@planner.test" });
      const res = await h.call("PATCH", "/api/v1/me", token, { headers: { "sec-fetch-site": "cross-site" }, body: {} });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Cross-site request blocked" });
    } finally {
      await h.close();
    }
  });

  it("blocks a non-GET request with neither Sec-Fetch-Site nor a matching Origin", async () => {
    const h: Harness = await startHarness({ configureAppEnv: { AUTH_MODE: "session", APP_BASE_URL: "https://budgetos.example" } });
    try {
      const token = await h.mint({ sub: "ip-csrf-none", email: "csrf-none@planner.test" });
      const res = await h.call("PATCH", "/api/v1/me", token, { body: {} });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await h.close();
    }
  });

  // A minted token names a real identity (sub/email) but not a seeded, active Budget OS user, so
  // "authenticated" routes refuse it too (FORBIDDEN, "Unknown or inactive user") — a different
  // failure than the CSRF guard's own 403, and the one these two tests check for instead of status
  // alone, since a same-origin or non-session request should get exactly that failure, never CSRF's.
  const notCsrfBlocked = (res: { status: number; body: Record<string, unknown> }) => {
    expect(res.status).toBeLessThan(500);
    if (res.status === 403) expect(res.body["message"]).not.toBe("Cross-site request blocked");
  };

  it("passes a same-origin request (Sec-Fetch-Site: same-origin, or a matching Origin)", async () => {
    const h: Harness = await startHarness({ configureAppEnv: { AUTH_MODE: "session", APP_BASE_URL: "https://budgetos.example" } });
    try {
      const token = await h.mint({ sub: "ip-csrf-same", email: "csrf-same@planner.test" });
      notCsrfBlocked(await h.call("PATCH", "/api/v1/me", token, { headers: { "sec-fetch-site": "same-origin" }, body: {} }));
      notCsrfBlocked(await h.call("PATCH", "/api/v1/me", token, { headers: { origin: "https://budgetos.example" }, body: {} }));
    } finally {
      await h.close();
    }
  });

  it("never applies outside session mode (the default harness is identity-platform)", async () => {
    const h = await startHarness();
    try {
      const token = await h.mint({ sub: "ip-csrf-off", email: "csrf-off@planner.test" });
      notCsrfBlocked(await h.call("PATCH", "/api/v1/me", token, { headers: { "sec-fetch-site": "cross-site" }, body: {} }));
    } finally {
      await h.close();
    }
  });
});
