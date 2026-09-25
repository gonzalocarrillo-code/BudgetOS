import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.mjs";

/** The MCP suites seed a golden workspace (≈10–60 s) and call every tool over HTTP. */
export default mergeConfig(
  root,
  defineConfig({
    test: {
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  }),
);
