import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bench/**/*.bench.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
