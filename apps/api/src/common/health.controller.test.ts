import { DomainError, httpStatus } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

/**
 * W5-1 (audit M-7) done-when: readiness touches the database and fails closed. No Postgres needed
 * here — the controller only cares that `$queryRaw` resolves or rejects; configure-app.ts's
 * `setGlobalPrefix` exclude and the `public` permission bypass that make `/ready` reachable
 * unauthenticated are exercised end-to-end in health.e2e.test.ts.
 */
describe("HealthController.ready", () => {
  it("returns ok when SELECT 1 succeeds", async () => {
    const prisma = { $queryRaw: async () => [{ "?column?": 1 }] };
    const controller = new HealthController(prisma as never);
    await expect(controller.ready()).resolves.toEqual({ status: "ok" });
  });

  it("throws a DomainError mapped to 503 UNAVAILABLE when the database is not reachable", async () => {
    const prisma = {
      $queryRaw: async () => {
        throw new Error("connection refused");
      },
    };
    const controller = new HealthController(prisma as never);
    await expect(controller.ready()).rejects.toBeInstanceOf(DomainError);
    try {
      await controller.ready();
      expect.unreachable();
    } catch (e) {
      const error = e as DomainError;
      expect(error.code).toBe("UNAVAILABLE");
      expect(httpStatus[error.code]).toBe(503);
      // Never the raw driver error (AGENTS §4).
      expect(error.message).not.toContain("connection refused");
    }
  });
});
