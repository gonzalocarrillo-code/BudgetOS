import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * Deployed hosting (ADR-065). WEB_DIST: the API also serves the built SPA, so the web and the API
 * share one origin behind IAP (no CORS, one sign-in); a path outside /api that is not a file gets
 * index.html (client-side routes). PUBLIC_ROUTES=slack: the public service answers only the signed
 * Slack routes and /health (Cloud Run reserves /healthz); everything else is 404, so nothing but Slack's callbacks is reachable
 * without IAP.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function serveWeb(app: NestFastifyApplication, env: NodeJS.ProcessEnv = process.env): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.get("/health", async (_req, reply) => reply.send("ok"));
  if (env["PUBLIC_ROUTES"] === "slack") {
    fastify.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      if (path !== "/health" && !path.startsWith("/api/v1/slack/")) await reply.code(404).send({ code: "NOT_FOUND", message: "Not found" });
    });
    return;
  }
  const dist = env["WEB_DIST"];
  if (!dist) return;
  const root = normalize(dist);
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const path = decodeURIComponent(req.url.split("?")[0] ?? "/");
    if (path.startsWith("/api/") || path === "/health") return;
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) return reply.code(404).send();
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile) file = join(root, "index.html");
    const hashed = file.includes(`${root}/assets/`);
    return reply
      .header("content-type", TYPES[extname(file)] ?? "application/octet-stream")
      .header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await readFile(file));
  });
}
