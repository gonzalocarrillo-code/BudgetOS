import { defineConfig } from "@playwright/test";
import { ISSUER, PORTS, PROJECT, dbEnv } from "./e2e/env.js";

/**
 * `pnpm test:e2e` (T-026): the real API and the Vite dev server, with auth verified against a
 * local JWKS. Local Chrome (channel "chrome"); set PW_CHANNEL= to use Playwright's Chromium.
 */
const env = dbEnv();
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: `http://127.0.0.1:${PORTS.web}`, ...(process.env["PW_CHANNEL"] === "" ? {} : { channel: process.env["PW_CHANNEL"] ?? "chrome" }), trace: "retain-on-failure" },
  webServer: [
    { command: "node_modules/.bin/tsx e2e/jwks-server.mts", port: PORTS.jwks, reuseExistingServer: false },
    {
      command: "node_modules/.bin/tsx src/main.ts",
      cwd: "../api",
      port: PORTS.api,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...env, PORT: String(PORTS.api), AUTH_AUDIENCE: PROJECT, AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/jwks`, NODE_ENV: "development" },
    },
    { command: "node_modules/.bin/vite", port: PORTS.web, reuseExistingServer: false, env: { WEB_PORT: String(PORTS.web), API_URL: `http://127.0.0.1:${PORTS.api}` } },
  ],
});
