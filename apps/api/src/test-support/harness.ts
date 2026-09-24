import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaClient } from "@prisma/client";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { AppModule } from "../app.module.js";

/**
 * Real Nest/Fastify app + a local JWKS for Identity Platform shaped test JWTs
 * (LOCAL_BUILD_PHASES finding 9). There is no auth bypass; tests sign tokens.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    const i = t.indexOf("=");
    if (t === "" || t.startsWith("#") || i === -1) continue;
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(join(repoRoot, "packages/db/.env"));

export const PROJECT = "budget-os-test";
export const ISSUER = `https://securetoken.google.com/${PROJECT}`;
const KID = "test-key-1";

export interface TestUser {
  id: string;
  email: string;
  sub: string;
}
export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export interface MintOptions {
  key?: CryptoKey;
  aud?: string;
  iss?: string;
  exp?: string;
  emailVerified?: boolean;
  googleSub?: string;
}

export const ownerDb = () => new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
export const appDb = () => new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });

/** Users seeded by tests carry googleSub `g-<sub>`, which `mint` puts in firebase.identities. */
export function testUser(label: string, id: string): TestUser {
  return { id, email: `${label.toLowerCase()}-${id}@planner.test`, sub: `ip-${id}` };
}

export interface Harness {
  app: NestFastifyApplication;
  foreignKey: CryptoKey;
  mint(u: { sub: string; email: string }, over?: MintOptions): Promise<string>;
  call(method: Method, url: string, token: string | null, opts?: { headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: Record<string, unknown>; text: string }>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const pair = await generateKeyPair("RS256");
  const foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const jwks = createServer((req, res) => {
    res.writeHead(req.url === "/jwks" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  process.env["AUTH_AUDIENCE"] = PROJECT;
  process.env["AUTH_ISSUER"] = ISSUER;
  process.env["AUTH_JWKS_URL"] = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"], abortOnError: false });
  app.setGlobalPrefix("api/v1");
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    foreignKey,
    mint: (u, over = {}) =>
      new SignJWT({
        email: u.email,
        email_verified: over.emailVerified ?? true,
        firebase: { sign_in_provider: "google.com", identities: { "google.com": [over.googleSub ?? `g-${u.sub}`] } },
      })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer(over.iss ?? ISSUER)
        .setAudience(over.aud ?? PROJECT)
        .setSubject(u.sub)
        .setIssuedAt()
        .setExpirationTime(over.exp ?? "10m")
        .sign(over.key ?? pair.privateKey),
    call: async (method, url, token, opts = {}) => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method,
        url,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
        ...(opts.body === undefined ? {} : { payload: opts.body as Record<string, unknown> }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
      } catch {
        // Non-JSON responses (e.g. text/csv) are in `text`.
      }
      return { status: res.statusCode, body, text: res.body };
    },
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    },
  };
}
