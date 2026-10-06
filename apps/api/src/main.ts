import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { configureApp } from "./configure-app.js";
import { AppModule } from "./app.module.js";
import { serveWeb } from "./serve-web.js";

export async function bootstrap(): Promise<void> {
  // S-6: Cloud Run terminates TLS and proxies every request, so the socket's peer is Google's
  // front end, not the caller; X-Forwarded-For is real there (K_SERVICE is set by the runtime)
  // and nowhere else, so IP-keyed rate limits use the real caller only in that environment.
  const trustProxy = Boolean(process.env["K_SERVICE"]);
  // W5-1: on Fastify, pino-http's own `genReqId` is never consulted (Fastify assigns `request.id`
  // before any middleware runs) — the generator belongs on the adapter instead, so the incoming
  // `X-Request-Id`, Fastify's `request.id`, the pino log lines and TenantInterceptor's audit
  // requestId all agree.
  const genReqId = (req: { headers: Record<string, string | string[] | undefined> }): string => {
    const header = req.headers["x-request-id"];
    const incoming = Array.isArray(header) ? header[0] : header;
    return incoming ?? randomUUID();
  };
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy, genReqId }), { bodyParser: false, bufferLogs: true });
  app.useLogger(app.get(Logger));
  await configureApp(app);
  serveWeb(app);
  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen(port, "0.0.0.0");
}

// `tsx src/main.ts` (pnpm dev, Playwright): start the server; importing this module does not.
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await bootstrap();
}
