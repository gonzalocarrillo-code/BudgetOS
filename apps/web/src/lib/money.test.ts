import { describe, expect, it } from "vitest";
import { moneyOrDash } from "./money.js";

describe("moneyOrDash", () => {
  it("formats and returns the value when it is a string", () => {
    expect(moneyOrDash("100.00", "USD")).toBe("USD 100.00");
    expect(moneyOrDash("0.00", "USD")).toBe("USD 0.00");
  });

  it("returns the no-value indicator (—) when value is null", () => {
    expect(moneyOrDash(null, "USD")).toBe("—");
  });

  it("returns the no-value indicator (—) when value is undefined", () => {
    expect(moneyOrDash(undefined, "USD")).toBe("—");
  });

  it("uses compact formatting when requested", () => {
    expect(moneyOrDash("1000000.00", "USD", true)).toBe("USD 1M");
    expect(moneyOrDash(null, "USD", true)).toBe("—");
  });
});
