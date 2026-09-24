import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bench/**/*.bench.ts"],
    // The DB bench would otherwise compete for CPU with the compile bench.
    fileParallelism: false,
  },
});
