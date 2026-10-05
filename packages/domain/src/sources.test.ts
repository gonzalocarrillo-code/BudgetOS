import { expect, it } from "vitest";
import { SourceConfig } from "./sources.js";

it("rejects invalid BigQuery projectId", () => {
  // Starts with uppercase
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "My-Project", dataset: "data", table: "t" })).toThrow();
  // Contains backtick
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "x`y", dataset: "data", table: "t" })).toThrow();
  // UNION ALL injection attempt
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "a.b UNION ALL SELECT", dataset: "data", table: "t" })).toThrow();
  // Ends with hyphen
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "my-project-", dataset: "data", table: "t" })).toThrow();
  // Too short
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "a123", dataset: "data", table: "t" })).toThrow();
  // Too long (>30 chars)
  expect(() => SourceConfig.parse({ kind: "bigquery", projectId: "a" + "b".repeat(30), dataset: "data", table: "t" })).toThrow();
});

it("accepts valid BigQuery projectId", () => {
  expect(SourceConfig.parse({ kind: "bigquery", projectId: "my-project-123", dataset: "data", table: "t" })).toBeDefined();
  expect(SourceConfig.parse({ kind: "bigquery", projectId: "xy12345", dataset: "data", table: "t" })).toBeDefined();
  // Minimum valid: 6 chars (a + 4 middle + final alphanumeric)
  expect(SourceConfig.parse({ kind: "bigquery", projectId: "a1b2c3", dataset: "data", table: "t" })).toBeDefined();
});

it("rejects invalid Snowflake account", () => {
  // Forward slash (path separator)
  expect(() => SourceConfig.parse({ kind: "snowflake", account: "evil.example/path", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toThrow();
  // Space
  expect(() => SourceConfig.parse({ kind: "snowflake", account: "account name", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toThrow();
  // At sign
  expect(() => SourceConfig.parse({ kind: "snowflake", account: "account@example", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toThrow();
});

it("accepts valid Snowflake account", () => {
  expect(SourceConfig.parse({ kind: "snowflake", account: "my-account", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toBeDefined();
  expect(SourceConfig.parse({ kind: "snowflake", account: "account_123", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toBeDefined();
  expect(SourceConfig.parse({ kind: "snowflake", account: "account.us-east-1", username: "u", warehouse: "w", database: "d", schema: "s", view: "v", secretRef: "projects/p/secrets/s" })).toBeDefined();
});
