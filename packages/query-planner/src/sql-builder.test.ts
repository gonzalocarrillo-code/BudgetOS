import { expect, it } from "vitest";
import { escapeLike } from "./sql-builder.js";

it("escapes LIKE wildcards and backslash", () => {
  expect(escapeLike("test%value")).toBe("test\\%value");
  expect(escapeLike("test_value")).toBe("test\\_value");
  expect(escapeLike("test\\value")).toBe("test\\\\value");
  expect(escapeLike("50%")).toBe("50\\%");
  expect(escapeLike("_private")).toBe("\\_private");
});

it("does not escape other characters", () => {
  expect(escapeLike("plain text")).toBe("plain text");
  expect(escapeLike("email@example.com")).toBe("email@example.com");
  expect(escapeLike("test-value")).toBe("test-value");
});

it("handles multiple escape sequences", () => {
  expect(escapeLike("%_\\%_")).toBe("\\%\\_\\\\\\%\\_");
});

it("handles empty string", () => {
  expect(escapeLike("")).toBe("");
});
