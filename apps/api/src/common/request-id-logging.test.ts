import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger, LoggerModule } from "nestjs-pino";
import { afterAll, describe, expect, it } from "vitest";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { pinoHttpOptions } from "./logging.js";

/**
 * W5-1 done-when (audit M-3): a 500 response's requestId matches the pino error line's requestId,
 * and a bearer token is redacted before it is ever written out — both need a destination stream
 * this process can actually read back. nestjs-pino builds one pino-http instance per process
 * (rootLogger.ts's `let middleware` module singleton, built on first use and never rebuilt), and
 * pino's own default destination writes straight to fd 1 via SonicBoom, bypassing
 * `process.stdout.write` entirely — unobservable from inside the same process. This file exists
 * only so it can be the first (and only) thing in its own vitest module registry to call
 * `LoggerModule.forRoot`, with an in-memory `Writable` as the second element of pino-http's
 * documented `[Options, DestinationStream]` tuple, using the exact same `pinoHttpOptions()`
 * common.module.ts runs with.
 */
class MemoryStream {
  lines: Record<string, unknown>[] = [];
  write(chunk: string): boolean {
    for (const line of chunk.split("\n")) {
      if (!line) continue;
      try {
        this.lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a JSON line (shouldn't happen for pino's own output); ignore.
      }
    }
    return true;
  }
}
const stream = new MemoryStream();

@Controller("probe")
class ProbeController {
  @Get("boom")
  boom(): never {
    throw new Error("something truly unexpected");
  }

  @Get("echo-auth")
  echoAuth(): { ok: true } {
    // Nothing to do with the Authorization header itself: the point is the auto-logged "request
    // completed" line, which carries the (redacted) request headers via pino-http's bound `req`
    // serializer.
    return { ok: true };
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions(), stream as unknown as Writable], assignResponse: true })],
  controllers: [ProbeController],
  providers: [
    // Same order as common.module.ts (see all-exceptions.filter.test.ts for why it matters).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
class ProbeModule {}

let app: NestFastifyApplication;
async function getApp(): Promise<NestFastifyApplication> {
  if (app) return app;
  app = await NestFactory.create<NestFastifyApplication>(
    ProbeModule,
    new FastifyAdapter({ genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID() }),
    { bufferLogs: true, abortOnError: false },
  );
  app.useLogger(app.get(Logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
afterAll(async () => {
  await app?.close();
});

describe("requestId correlation (audit M-3)", () => {
  it("a 500 response's requestId matches the pino error line's requestId", async () => {
    const nest = await getApp();
    const requestId = `test-${randomUUID()}`;
    const res = await nest.getHttpAdapter().getInstance().inject({ method: "GET", url: "/probe/boom", headers: { "x-request-id": requestId } });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["requestId"]).toBe(requestId);
    const errorLine = stream.lines.find((l) => l["level"] === 50 && l["requestId"] === requestId);
    expect(errorLine).toBeDefined();
    expect(errorLine?.["code"]).toBe("INTERNAL");
  });
});

describe("log redaction (AGENTS §4, audit M-3)", () => {
  it("never writes a bearer token to the log; the authorization field is [Redacted]", async () => {
    const nest = await getApp();
    const requestId = `test-${randomUUID()}`;
    const token = `secret-bearer-token-${randomUUID()}`;
    const res = await nest.getHttpAdapter().getInstance().inject({ method: "GET", url: "/probe/echo-auth", headers: { "x-request-id": requestId, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const requestLine = stream.lines.find((l) => l["requestId"] === requestId);
    expect(requestLine).toBeDefined();
    const req = requestLine?.["req"] as { headers?: Record<string, unknown> } | undefined;
    expect(req?.headers?.["authorization"]).toBe("[Redacted]");
    // Belt and braces: the raw token string is nowhere in anything this process wrote out.
    expect(JSON.stringify(stream.lines)).not.toContain(token);
  });
});
