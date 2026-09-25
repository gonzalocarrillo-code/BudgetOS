import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_DIR, E2E_DIR, STATE_FILE } from "./env.js";

/** Seeds a golden workspace through the real commands (a tsx child: the API code uses decorators). */
export default function globalSetup(): void {
  const tsx = join(E2E_DIR, "../node_modules/.bin/tsx");
  const out = execFileSync(tsx, [join(E2E_DIR, "seed.mts")], { encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "inherit"] });
  const last = out.trim().split("\n").at(-1) ?? "{}";
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(STATE_FILE, last);
}
