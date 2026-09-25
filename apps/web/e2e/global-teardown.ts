import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, STATE_FILE } from "./env.js";

export default function globalTeardown(): void {
  const tsx = join(E2E_DIR, "../node_modules/.bin/tsx");
  execFileSync(tsx, [join(E2E_DIR, "seed.mts"), "cleanup", readFileSync(STATE_FILE, "utf8")], { stdio: "inherit", timeout: 120_000 });
}
