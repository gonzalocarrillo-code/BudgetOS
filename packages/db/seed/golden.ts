import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm db:seed [--size small|large]` (spec §2 script). The generator has to call the real envelope
 * and approval commands, which live in apps/api, and @budget/db cannot import apps/api (api depends
 * on db). So this entry runs apps/api/src/seed/golden.ts in a child process; see ADR-007.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = spawnSync("pnpm", ["--filter", "@budget/api", "seed:golden", "--", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
