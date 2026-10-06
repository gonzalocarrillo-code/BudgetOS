import process from "node:process";
import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/**
 * The API suites seed whole golden workspaces through the real commands (≈11 s each) and one
 * commits 10k rows. Run at most three files at once so seeding stays inside its own timing checks,
 * and give multi-step HTTP flows 30 s instead of vitest's 5 s default.
 *
 * ADR-073: `VITEST_MAX_WORKERS` (default 3, as above) overrides it. CI ran these files one at a
 * time while concurrent seeding deadlocked in `ensure_fact_partitions`; W3-10 fixed that deadlock
 * (migration 20261015020000) and W0-6 (#186) the test-cleanup race on `audit_event_immutable`,
 * so CI is back to 3.
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
