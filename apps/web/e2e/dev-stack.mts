import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_DIR, E2E_DIR, ISSUER, PORTS, PROJECT, STATE_FILE, dbEnv } from "./env.js";

/**
 * `pnpm --filter @budget/web e2e:stack`: the Playwright stack by hand (JWKS, API, Vite on
 * PORTS.web) with a fresh golden workspace, for looking at the app in a browser. Prints a signed
 * token for the golden admin to paste into the sign-in screen. Ctrl-C stops everything and
 * removes the workspace.
 */
const tsx = join(E2E_DIR, "../node_modules/.bin/tsx");
const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(c);
};
mkdirSync(AUTH_DIR, { recursive: true });
run(tsx, [join(E2E_DIR, "jwks-server.mts")], join(E2E_DIR, ".."));
const seeded = execFileSync(tsx, [join(E2E_DIR, "seed.mts")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1) ?? "{}";
writeFileSync(STATE_FILE, seeded);
run(join(E2E_DIR, "../node_modules/.bin/tsx"), ["src/main.ts"], join(E2E_DIR, "../../api"), { ...dbEnv(), PORT: String(PORTS.api), AUTH_AUDIENCE: PROJECT, AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/jwks` });
run(join(E2E_DIR, "../node_modules/.bin/vite"), [], join(E2E_DIR, ".."), { WEB_PORT: String(PORTS.web), API_URL: `http://127.0.0.1:${PORTS.api}` });
await new Promise((r) => setTimeout(r, 1500));
const { tokenFor } = await import("./auth.js");
process.stdout.write(`\nworkspace ${JSON.parse(seeded).workspaceId}\nadmin token, valid 8 h while this stack runs (paste at http://127.0.0.1:${PORTS.web}):\n${await tokenFor("admin", { expiresIn: "8h" })}\n\n`);
const stop = () => {
  children.forEach((c) => c.kill());
  execFileSync(tsx, [join(E2E_DIR, "seed.mts"), "cleanup", readFileSync(STATE_FILE, "utf8")], { stdio: "inherit" });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
