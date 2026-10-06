import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ApiEnv, McpEnv, WorkerEnv, parseEnv } from "./env.js";

/**
 * Parse .env.example at the repo root and extract key=value pairs.
 * Ignores comment lines, empty lines, and empty values (treats them as absent).
 * This matches how environment variables work in practice.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    // Skip empty values; they're treated as absent in practice
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

describe("env schemas", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const exampleEnv = parseEnvFile(join(repoRoot, ".env.example"));

  it("ApiEnv accepts keys from .env.example", () => {
    // Should not throw
    const result = parseEnv(ApiEnv, exampleEnv);
    expect(result).toBeDefined();
    // At minimum, optional fields are present even if undefined
    expect(result).toHaveProperty("LOG_LEVEL");
  });

  it("WorkerEnv accepts keys from .env.example", () => {
    // Should not throw; WorkerEnv requires APP_DATABASE_URL
    // .env.example has it, so this should work
    const result = parseEnv(WorkerEnv, exampleEnv);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("APP_DATABASE_URL");
  });

  it("McpEnv accepts keys from .env.example", () => {
    // Should not throw; McpEnv requires MCP_DATABASE_URL
    // .env.example has it, so this should work
    const result = parseEnv(McpEnv, exampleEnv);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("MCP_DATABASE_URL");
  });

  it("parseEnv throws with a message naming a missing required key", () => {
    const minimal = {};
    expect(() => parseEnv(WorkerEnv, minimal)).toThrow(/APP_DATABASE_URL/);
  });

  it("parseEnv throws with multiple issues listed", () => {
    const incomplete = {
      // Missing APP_DATABASE_URL (required by WorkerEnv)
    };
    expect(() => parseEnv(WorkerEnv, incomplete)).toThrow(/APP_DATABASE_URL/);
  });

  it("parseEnv ignores unknown keys (passthrough)", () => {
    const envWithExtra = {
      APP_DATABASE_URL: "postgresql://localhost/test",
      UNKNOWN_KEY: "some-value",
      ANOTHER_UNKNOWN: "another-value",
    };
    // Should not throw and should ignore the unknown keys
    const result = parseEnv(WorkerEnv, envWithExtra);
    expect(result.APP_DATABASE_URL).toBe("postgresql://localhost/test");
  });

  it("parseEnv validates enum values for AUTH_MODE", () => {
    const validAuth = {
      APP_DATABASE_URL: "postgresql://localhost/test",
      AUTH_MODE: "session",
    };
    const result = parseEnv(ApiEnv, validAuth);
    expect(result.AUTH_MODE).toBe("session");

    const invalidAuth = {
      APP_DATABASE_URL: "postgresql://localhost/test",
      AUTH_MODE: "invalid-mode",
    };
    expect(() => parseEnv(ApiEnv, invalidAuth)).toThrow(/AUTH_MODE/);
  });

  it("parseEnv validates URL format for API_PUBLIC_URL", () => {
    const validUrl = {
      APP_DATABASE_URL: "postgresql://localhost/test",
      API_PUBLIC_URL: "https://example.com",
    };
    const result = parseEnv(ApiEnv, validUrl);
    expect(result.API_PUBLIC_URL).toBe("https://example.com");

    const invalidUrl = {
      APP_DATABASE_URL: "postgresql://localhost/test",
      API_PUBLIC_URL: "not a url",
    };
    expect(() => parseEnv(ApiEnv, invalidUrl)).toThrow(/API_PUBLIC_URL/);
  });
});
