import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessRepository, JwtVerifier, MemoryRoleCache } from "@budget/api/auth";
import { MemoryObjectStore } from "@budget/workers";
import { PrismaClient } from "@prisma/client";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { buildHttp } from "../http.js";
import { MemoryRateLimiter } from "../rate-limit.js";

/**
 * Test harness for the MCP server: env from packages/db/.env, a local JWKS signing Identity
 * Platform shaped tokens (as the API harness does), the Fastify app on a random port with the
 * `budget_mcp` connection, and an SDK client per call.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const envFile = join(repoRoot, "packages/db/.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};

export const ownerDb = () => new PrismaClient({ datasources: { db: { url: required("DATABASE_URL") } } });
export const appDb = () => new PrismaClient({ datasources: { db: { url: required("APP_DATABASE_URL") } } });
export const mcpDb = () => new PrismaClient({ datasources: { db: { url: required("MCP_DATABASE_URL") } } });

const PROJECT = "budget-os-test";
export interface Person {
  email: string;
  googleSub: string;
}
export interface ToolResult {
  isError: boolean;
  body: Record<string, unknown>;
}
export interface McpHarness {
  store: MemoryObjectStore;
  mint(p: Person): Promise<string>;
  call(token: string, tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  client(token: string): Promise<Client>;
  post(headers: Record<string, string>, body: unknown): Promise<number>;
  close(): Promise<void>;
}

export async function startMcp(opts: { limit?: number } = {}): Promise<McpHarness> {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "t025", alg: "RS256", use: "sig" };
  const jwks = createServer((req, res) => {
    res.writeHead(req.url === "/jwks" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  process.env["AUTH_AUDIENCE"] = PROJECT;
  process.env["AUTH_ISSUER"] = `https://securetoken.google.com/${PROJECT}`;
  process.env["AUTH_JWKS_URL"] = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;

  const prisma = mcpDb();
  const store = new MemoryObjectStore();
  const app = buildHttp({ prisma, auth: { verifier: new JwtVerifier(), access: new AccessRepository(prisma), cache: new MemoryRoleCache() }, limiter: new MemoryRateLimiter(opts.limit ?? 10_000), store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);

  const client = async (token: string) => {
    const c = new Client({ name: "t025-test", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof c.connect>[0]);
    return c;
  };
  return {
    store,
    mint: (p) =>
      new SignJWT({ email: p.email, email_verified: true, firebase: { sign_in_provider: "google.com", identities: { "google.com": [p.googleSub] } } })
        .setProtectedHeader({ alg: "RS256", kid: "t025" })
        .setIssuer(`https://securetoken.google.com/${PROJECT}`)
        .setAudience(PROJECT)
        .setSubject(`ip-${randomUUID()}`)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey),
    client,
    call: async (token, tool, args = {}) => {
      const c = await client(token);
      try {
        const res = (await c.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
        return { isError: res.isError === true, body: JSON.parse(res.content[0]?.text ?? "{}") as Record<string, unknown> };
      } finally {
        await c.close();
      }
    },
    post: async (headers, body) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
      await res.text();
      return res.status;
    },
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    },
  };
}
