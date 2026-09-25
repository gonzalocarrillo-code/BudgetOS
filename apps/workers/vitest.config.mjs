import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/**
 * The worker suites run against Postgres (and the GCS emulator). Under `turbo run test`, every
 * package's database suites share the machine, so give each test 20 s instead of vitest's 5 s,
 * as apps/api does for the same reason.
 */
export default mergeConfig(
  root,
  defineConfig({
    test: {
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  }),
);
