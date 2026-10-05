import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/**
 * The API suites seed whole golden workspaces through the real commands (≈11 s each) and one
 * commits 10k rows. Run at most three files at once so seeding stays inside its own timing checks,
 * and give multi-step HTTP flows 30 s instead of vitest's 5 s default.
 *
 * ADR-073: `VITEST_MAX_WORKERS` (default 3, as above) lets ci.yml force this down to 1. Several
 * suites share one golden-style workspace pattern and concurrent seeding surfaced a real Postgres
 * deadlock in `ensure_fact_partitions` plus cross-file data pollution on GitHub's runner — both are
 * product bugs for their own item (not this one), so CI runs these files one at a time instead.
 */
const maxWorkers = Number(process.env["VITEST_MAX_WORKERS"] ?? 3);
export default mergeConfig(
  root,
  defineConfig({
    test: {
      testTimeout: 30_000,
      maxWorkers,
      minWorkers: 1,
    },
  }),
);
