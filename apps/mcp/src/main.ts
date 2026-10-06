import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { AccessRepository, JwtVerifier, McpOAuth, MemoryRoleCache, type OAuthStore } from "@budget/api/auth";
import { consumeOauthCode, consumeRefreshToken, issueRefreshToken } from "@budget/db";
import { objectStoreFromEnv } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import { buildHttp } from "./http.js";
import { log } from "./log.js";
import { rateLimiterFromEnv } from "./rate-limit.js";

/**
 * W5-3 (audit S-12): this is the MCP side of McpOAuth's OAuthStore — exchangeCode's single-use
 * check and refresh()'s rotation, both running as budget_mcp (EXECUTE on app_consume_code,
 * app_issue_refresh, app_consume_refresh only; it has no grant to call app_issue_code, since
 * codes are only ever issued on the api side, apps/api/src/serve-web.ts).
 */
function mcpOAuthStore(prisma: PrismaClient): OAuthStore {
  return {
    // Codes are issued only on the api side (serve-web.ts's /oauth/authorize); budget_mcp has no
    // EXECUTE grant on app_issue_code, and McpOAuth never calls issueCode() from exchangeCode/refresh.
    issueCode: async () => {
      throw new Error("MCP does not issue authorization codes");
    },
    consumeCode: (codeHash) => consumeOauthCode(prisma, codeHash),
    issueRefresh: (input) => issueRefreshToken(prisma, input),
    consumeRefresh: (jti) => consumeRefreshToken(prisma, jti),
  };
}

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
  const oauth = McpOAuth.fromEnv(process.env, mcpOAuthStore(prisma));
  const verifier = oauth ? (oauth.verifier() as unknown as JwtVerifier) : new JwtVerifier();
  const config = oauth ? { oauth, publicUrl: (process.env["MCP_PUBLIC_URL"] ?? "").replace(/\/$/, ""), appUrl: (process.env["APP_BASE_URL"] ?? "").replace(/\/$/, "") } : null;
  if (config && (!config.publicUrl || !config.appUrl)) throw new Error("MCP_PUBLIC_URL and APP_BASE_URL are required with MCP_OAUTH_KEY");
  // S-6: trust Cloud Run's X-Forwarded-For (K_SERVICE is set by the runtime) so the /oauth/*
  // rate limit keys on the real caller, not the front end's own address.
  const app = await buildHttp({ prisma, auth: { verifier, access: new AccessRepository(prisma), cache: new MemoryRoleCache() }, limiter: await rateLimiterFromEnv(), store: objectStoreFromEnv() }, config, { trustProxy: Boolean(process.env["K_SERVICE"]) });
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
