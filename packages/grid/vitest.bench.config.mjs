import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bench/**/*.bench.ts"],
    testTimeout: 120_000,
    // grid-core times CPU loops; budget-grid drives Chrome. Running them side by side skews the ratios.
    fileParallelism: false,
  },
});
