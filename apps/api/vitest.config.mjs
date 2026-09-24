import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/**
 * The API suites seed whole golden workspaces through the real commands (≈11 s each) and one
 * commits 10k rows. Run at most three files at once so seeding stays inside its own timing checks,
 * and give multi-step HTTP flows 30 s instead of vitest's 5 s default.
 */
export default mergeConfig(
  root,
  defineConfig({
    test: {
      testTimeout: 30_000,
      maxWorkers: 3,
      minWorkers: 1,
    },
  }),
);
