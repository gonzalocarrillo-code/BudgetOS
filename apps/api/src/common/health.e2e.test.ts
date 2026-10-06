import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-support/harness.js";

/**
 * W5-1 done-when, against the real AppModule and Postgres: /ready is reachable with no auth token
 * (the "public" permission bypass plus configure-app.ts's setGlobalPrefix exclude), and
 * X-Request-Id is echoed on an ordinary authenticated call. The requestId↔log-line and redaction
 * done-whens need a capturable log destination, which the real app's pino-http singleton (its
 * default destination writes straight to a file descriptor, bypassing process.stdout.write) can't
 * give a test in this process — see request-id-logging.test.ts, which runs the exact same
 * `pinoHttpOptions()` common.module.ts does, with a destination it can read back.
 */
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("GET /ready (audit M-7)", () => {
  it("answers 200 with no auth token", async () => {
    harness = await startHarness();
    const res = await harness.call("GET", "/ready", null);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is unprefixed, like /health", async () => {
    harness = await startHarness();
    const res = await harness.call("GET", "/api/v1/ready", null);
    expect(res.status).toBe(404);
  });
});

describe("X-Request-Id (audit M-3)", () => {
  it("echoes the caller's X-Request-Id on an ordinary response", async () => {
    harness = await startHarness();
    const res = await harness.call("GET", "/ready", null, { headers: { "x-request-id": "caller-supplied-id" } });
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("caller-supplied-id");
  });

  it("is also carried on an error response (a 403 from an unseeded but verified caller)", async () => {
    harness = await startHarness();
    const token = await harness.mint({ sub: "ip-reqid", email: "reqid@planner.test" });
    const res = await harness.call("GET", "/api/v1/me", token, { headers: { "x-request-id": "caller-supplied-id-2" } });
    expect(res.status).toBe(403);
    expect(res.headers["x-request-id"]).toBe("caller-supplied-id-2");
  });

  it("mints one when the caller sends none", async () => {
    harness = await startHarness();
    const res = await harness.call("GET", "/ready", null);
    expect(typeof res.headers["x-request-id"]).toBe("string");
    expect((res.headers["x-request-id"] as string).length).toBeGreaterThan(0);
  });
});
