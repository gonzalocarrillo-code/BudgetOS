import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/**
 * The worker suites run against Postgres (and the GCS emulator). Under `turbo run test`, every
 * package's database suites share the machine, so give each test 20 s instead of vitest's 5 s,
 * as apps/api does for the same reason.
 *
 * W0-1: unlike apps/api (which caps at 3 workers for the same reason), these suites race when
 * vitest's default file-level parallelism runs them concurrently against the same outbox-consumer
 * dedupe state (observed: rollup/notify tests flip "applied" to "duplicate" under concurrency, and
 * a spend_fact partition lookup fails intermittently). Files already run sequentially within one
 * file, so run files sequentially too rather than rework the worker suites' shared state.
 */
export default mergeConfig(
  root,
  defineConfig({
    test: {
      testTimeout: 20_000,
      hookTimeout: 30_000,
      fileParallelism: false,
    },
  }),
);
