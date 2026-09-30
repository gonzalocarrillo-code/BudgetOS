import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { AccessRepository, JwtVerifier, McpOAuth, MemoryRoleCache } from "@budget/api/auth";
import { objectStoreFromEnv } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import { buildHttp } from "./http.js";
import { log } from "./log.js";
import { rateLimiterFromEnv } from "./rate-limit.js";

export { buildServer } from "./server.js";
export type { McpDeps } from "./server.js";
export { buildHttp } from "./http.js";
export { CALLS_PER_MINUTE, MemoryRateLimiter } from "./rate-limit.js";

/** Cloud Run service `mcp-readonly` (spec §16). Connects as `budget_mcp` (MCP_DATABASE_URL). */
async function main(): Promise<void> {
  const url = process.env["MCP_DATABASE_URL"];
  if (!url) throw new Error("MCP_DATABASE_URL is required (the read-only budget_mcp role)");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  // ADR-066: with MCP_OAUTH_KEY, callers bring this server's own OAuth access tokens.
  const oauth = McpOAuth.fromEnv();
  const verifier = oauth ? (oauth.verifier() as unknown as JwtVerifier) : new JwtVerifier();
  const config = oauth ? { oauth, publicUrl: (process.env["MCP_PUBLIC_URL"] ?? "").replace(/\/$/, ""), appUrl: (process.env["APP_BASE_URL"] ?? "").replace(/\/$/, "") } : null;
  if (config && (!config.publicUrl || !config.appUrl)) throw new Error("MCP_PUBLIC_URL and APP_BASE_URL are required with MCP_OAUTH_KEY");
  const app = buildHttp({ prisma, auth: { verifier, access: new AccessRepository(prisma), cache: new MemoryRoleCache() }, limiter: await rateLimiterFromEnv(), store: objectStoreFromEnv() }, config);
  const port = Number(process.env["PORT"] ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "mcp-readonly listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "mcp-readonly crashed");
    process.exit(1);
  });
}
