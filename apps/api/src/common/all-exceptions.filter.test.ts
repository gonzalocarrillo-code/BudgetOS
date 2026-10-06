import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Controller, ForbiddenException, Get, Module } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Prisma } from "@prisma/client";
import { DomainError } from "@budget/domain";
import { Logger, LoggerModule } from "nestjs-pino";
import { afterEach, describe, expect, it } from "vitest";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { pinoHttpOptions } from "./logging.js";

/**
 * W5-1 (audit M-3, I-15): the catch-all filter's Prisma/Postgres mapping, its ordering against
 * DomainExceptionFilter, and the requestId↔log correlation — all independent of auth, tenancy and
 * the real database, so this is a plain Nest app (no AppModule, no Postgres) with one throwaway
 * controller that throws exactly the error each test needs.
 */
function prismaError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("a raw driver message that must never reach the client", meta === undefined ? { code, clientVersion: "test" } : { code, clientVersion: "test", meta });
}

@Controller("throw")
class ThrowController {
  @Get("domain-not-found")
  domainNotFound(): never {
    throw new DomainError("NOT_FOUND", "no such thing");
  }
  @Get("p2002")
  p2002(): never {
    throw prismaError("P2002", { target: ["email"] });
  }
  @Get("p2034")
  p2034(): never {
    throw prismaError("P2034");
  }
  @Get("p2025")
  p2025(): never {
    throw prismaError("P2025");
  }
  @Get("p2028")
  p2028(): never {
    throw prismaError("P2028");
  }
  @Get("deadlock")
  deadlock(): never {
    throw prismaError("P2010", { code: "40P01", message: "deadlock detected" });
  }
  @Get("unique-raw")
  uniqueRaw(): never {
    throw prismaError("P2010", { code: "23505", message: "duplicate key value" });
  }
  @Get("unmapped-raw")
  unmappedRaw(): never {
    throw prismaError("P2010", { code: "42601" });
  }
  @Get("boom")
  boom(): never {
    throw new Error("something truly unexpected, with a stack trace");
  }
  @Get("forbidden")
  forbidden(): never {
    throw new ForbiddenException("not for you");
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions() })],
  controllers: [ThrowController],
  providers: [
    // Order matters: this is what common.module.ts does. Nest applies global filters most-
    // recently-provided first, so AllExceptionsFilter (declared first here, checked last) does not
    // shadow DomainExceptionFilter's more specific @Catch(DomainError) — proven below by the
    // NOT_FOUND case not degrading to INTERNAL.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
class ThrowModule {}

async function start(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ThrowModule,
    new FastifyAdapter({ genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID() }),
    { bufferLogs: true, abortOnError: false },
  );
  app.useLogger(app.get(Logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("AllExceptionsFilter ordering (W5-1, audit M-3)", () => {
  it("still lets a DomainError through DomainExceptionFilter's own mapping, not the catch-all's", async () => {
    app = await start();
    const res = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/throw/domain-not-found" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ code: "NOT_FOUND", message: "no such thing" });
  });
});

describe("AllExceptionsFilter passes a NestJS HttpException through with its own status", () => {
  it("an unmatched route keeps Nest's real 404, not a generic 500 (regression: a bare @Catch() must not shadow Nest's own NotFoundException)", async () => {
    app = await start();
    const res = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/throw/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a ForbiddenException keeps its own 403 and message", async () => {
    app = await start();
    const res = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/throw/forbidden" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "FORBIDDEN", message: "not for you" });
  });
});

describe("AllExceptionsFilter Prisma/Postgres mapping (audit I-15)", () => {
  it.each([
    ["/throw/p2002", 409, "CONFLICT"],
    ["/throw/p2034", 409, "CONFLICT"],
    ["/throw/p2025", 404, "NOT_FOUND"],
    ["/throw/p2028", 503, "UNAVAILABLE"],
    ["/throw/deadlock", 409, "CONFLICT"],
    ["/throw/unique-raw", 409, "CONFLICT"],
    ["/throw/unmapped-raw", 500, "INTERNAL"],
    ["/throw/boom", 500, "INTERNAL"],
  ])("%s -> %i %s", async (url, status, code) => {
    app = await start();
    const res = await app.getHttpAdapter().getInstance().inject({ method: "GET", url });
    expect(res.statusCode).toBe(status);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["code"]).toBe(code);
    // Never the raw Prisma/driver message (AGENTS §4).
    expect(JSON.stringify(body)).not.toContain("raw driver message");
  });
});

describe("requestId correlation (audit M-3)", () => {
  // The X-Request-Id *response header* is configure-app.ts's onSend hook, exercised end-to-end
  // (with the real AppModule) in health.e2e.test.ts; a 500 body's requestId matching the pino error
  // line's requestId needs a capturable log destination, which nestjs-pino's module-level pino-http
  // singleton only accepts on its first use per process — see request-id-logging.test.ts, its own
  // file for exactly that reason.
  it("a 500 response body carries a requestId (the log-line match is request-id-logging.test.ts)", async () => {
    app = await start();
    const requestId = `test-${randomUUID()}`;
    const res = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/throw/boom", headers: { "x-request-id": requestId } });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["code"]).toBe("INTERNAL");
    expect(body["requestId"]).toBe(requestId);
  });
});
