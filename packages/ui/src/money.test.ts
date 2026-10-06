import { describe, expect, it, vi } from "vitest";
import { moneyOrDash } from "./money.js";

// Mock the i18n to avoid circular dependencies
vi.mock("./i18n.js", () => ({
  t: (key: string) => {
    if (key === "noValue") return "—";
    return key;
  },
}));

describe("moneyOrDash", () => {
  it("returns the no-value indicator (—) when value is null", () => {
    expect(moneyOrDash(null, "USD")).toBe("—");
  });

  it("returns the no-value indicator (—) when value is undefined", () => {
    expect(moneyOrDash(undefined, "USD")).toBe("—");
  });

  // Note: Testing the actual formatting requires @budget/grid which
  // is tested in heatmap.tsx and headline.tsx integration tests
});
