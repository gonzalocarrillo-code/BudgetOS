import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it } from "vitest";
import { configureApp } from "./configure-app.js";
import { serveWeb } from "./serve-web.js";

/**
 * S-6 done-when, for the routes `serveWeb` itself registers (the auth/login rate limit, and
 * logout's method change): a minimal Nest app with no AppModule/database, since none of
 * `/auth/login`, `/auth/callback` (unreached here) or `/auth/logout` touch the database.
 */
@Module({})
class EmptyModule {}

const ENV = {
  AUTH_MODE: "session",
  GOOGLE_OAUTH_CLIENT_ID: "client-123.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  SESSION_KEY: "k".repeat(48),
  APP_BASE_URL: "https://budgetos.example",
} satisfies Record<string, string>;

async function start(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(EmptyModule, new FastifyAdapter(), { logger: ["error"], abortOnError: false, bodyParser: false });
  await configureApp(app, ENV);
  serveWeb(app, ENV);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET/POST /auth/logout (S-6)", () => {
  it("no longer logs out on GET (405), and logs out on POST", async () => {
    app = await start();
    const fastify = app.getHttpAdapter().getInstance();
    const get = await fastify.inject({ method: "GET", url: "/auth/logout" });
    expect(get.statusCode).toBe(405);
    expect(get.headers["set-cookie"]).toBeUndefined();
    const post = await fastify.inject({ method: "POST", url: "/auth/logout", headers: { "sec-fetch-site": "same-origin" } });
    expect(post.statusCode).toBe(302);
    expect(String(post.headers["set-cookie"])).toContain("budgetos_session=;");
  });
});

describe("rate limiting on /auth/* (S-6)", () => {
  it("answers 429 after 20 requests to /auth/login within a minute", async () => {
    app = await start();
    const fastify = app.getHttpAdapter().getInstance();
    let last: Awaited<ReturnType<typeof fastify.inject>> | undefined;
    for (let i = 0; i < 20; i++) {
      last = await fastify.inject({ method: "GET", url: "/auth/login" });
      expect(last.statusCode).toBe(302);
    }
    const res = await fastify.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toMatchObject({ code: "RATE_LIMITED" });
  });
});
