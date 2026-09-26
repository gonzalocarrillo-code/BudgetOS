import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `pnpm dev:local`: a persistent localhost stack — web http://localhost:5173, API :3000 — that
 * survives restarts. One signing key (e2e/.auth-local, gitignored), one golden workspace (slug
 * `local`, seeded on the first start and reused after), and long-lived tokens for every persona
 * (a year; valid across restarts because the key is kept). The web dev server signs in as the
 * golden admin automatically; sign out to paste another persona's token from tokens.json.
 * Ctrl-C stops the processes and keeps the data. `pnpm db:reset` starts over.
 */
process.env["E2E_PROFILE"] = "local";
const { AUTH_DIR, E2E_DIR, ISSUER, PORTS, PROJECT, STATE_FILE, TOKENS_FILE, dbEnv } = await import("./env.js");

const tsx = join(E2E_DIR, "../node_modules/.bin/tsx");
const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(c);
};
mkdirSync(AUTH_DIR, { recursive: true });
run(tsx, [join(E2E_DIR, "jwks-server.mts")], join(E2E_DIR, ".."), { JWKS_PERSIST: "1" });
await new Promise((r) => setTimeout(r, 800)); // the key file exists before tokens are signed

// Seeded once: seedGolden reuses a workspace whose slug exists.
const seeded = execFileSync(tsx, [join(E2E_DIR, "seed.mts")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, SEED_SLUG: "local" } }).trim().split("\n").at(-1) ?? "{}";
writeFileSync(STATE_FILE, seeded);

const { tokenFor } = await import("./auth.js");
const personas = ["admin", "orgAdmin", "planner", "budgetOwner", "approver", "finance1", "finance2"];
const tokens = Object.fromEntries(await Promise.all(personas.map(async (p) => [p, await tokenFor(p, { expiresIn: "365d" })] as const)));
writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));

run(tsx, ["src/main.ts"], join(E2E_DIR, "../../api"), { ...dbEnv(), PORT: String(PORTS.api), AUTH_AUDIENCE: PROJECT, AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/jwks`, CLOSURE_SINK: "memory" });
run(join(E2E_DIR, "../../workers/node_modules/.bin/tsx"), ["src/local-runner.ts"], join(E2E_DIR, "../../workers"), { ...dbEnv(), PORT: String(PORTS.worker), LOCAL_WORKSPACE_PREFIX: "local" });
run(join(E2E_DIR, "../node_modules/.bin/vite"), [], join(E2E_DIR, ".."), { WEB_PORT: String(PORTS.web), API_URL: `http://127.0.0.1:${PORTS.api}`, VITE_DEV_ID_TOKEN: tokens["admin"] ?? "" });

const { workspaceId } = JSON.parse(seeded) as { workspaceId: string };
process.stdout.write(
  `\nBudget OS on http://localhost:${PORTS.web}/w/${workspaceId} — signed in as the golden admin.\nPersona tokens (valid a year, across restarts): ${TOKENS_FILE}\n\n`,
);
const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
