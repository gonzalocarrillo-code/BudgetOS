import { describe, expect, it } from "vitest";
import { formatChange, formatPctChange } from "./editors.js";

describe("compare formats (Phase E)", () => {
  it("signs a change of money and a change in percent", () => {
    expect(formatChange("300", "USD")).toBe("+USD 300.00");
    expect(formatChange("-1500.5", "EUR")).toBe("-EUR 1,500.50");
    expect(formatChange("0", "USD")).toBe("USD 0.00");
    expect(formatPctChange("0.032")).toBe("+3.2%");
    expect(formatPctChange("-0.71428")).toBe("-71.4%");
    expect(formatPctChange("0")).toBe("0.0%");
  });
});
