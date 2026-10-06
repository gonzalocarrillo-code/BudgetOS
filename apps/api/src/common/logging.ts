import type { Options } from "pino-http";

/**
 * W5-1 (AGENTS §4, audit M-3): the pino-http configuration the real app (common.module.ts) runs
 * with, pulled out so a test can feed the exact same options to its own `LoggerModule.forRoot`
 * with a capturable destination stream — `nestjs-pino`'s pino-http instance is a module-level
 * singleton (`ensureLoggerMiddleware`'s `let middleware`), built once per process from whichever
 * `LoggerModule.forRoot` runs first, so the real app's instance (default destination: a direct fd
 * write, not `process.stdout.write`) can't be intercepted from a test that imports it. See
 * request-id-logging.test.ts.
 */
export function pinoHttpOptions(env: NodeJS.ProcessEnv = process.env): Options {
  return {
    level: env["LOG_LEVEL"] ?? "info",
    base: { service: env["K_SERVICE"] ?? "api" },
    // pino-http only binds a flat id field (its own default name: "reqId") in "quiet" mode, which
    // drops the full `req` object from every line in exchange — not a trade worth making just for
    // the field name. `customProps` adds "requestId" (AGENTS §4's name, matching
    // apps/workers/src/log.ts and apps/mcp/src/log.ts) as its own binding alongside the full `req`
    // object, on every line this request's logger writes, auto-logged or not.
    customProps: (req) => ({ requestId: req.id }),
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-goog-iap-jwt-assertion"]', "*.password", "*.token", "*.secret"],
      censor: "[Redacted]",
    },
  };
}
