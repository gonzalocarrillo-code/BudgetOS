import { describe, expect, it } from "vitest";
import { formatChange, formatMoneyCompact, formatPctChange } from "./editors.js";

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

describe("compact money (HO-002)", () => {
  it("shortens to k, M and B with two significant decimals at most, never rounding past a unit", () => {
    expect(formatMoneyCompact("0", "USD")).toBe("USD 0");
    expect(formatMoneyCompact("950.49", "USD")).toBe("USD 950");
    expect(formatMoneyCompact("999.5", "USD")).toBe("USD 1k");
    expect(formatMoneyCompact("7912.40", "USD")).toBe("USD 7.9k");
    expect(formatMoneyCompact("10000", "EUR")).toBe("EUR 10k");
    expect(formatMoneyCompact("653984.46", "USD")).toBe("USD 654k");
    expect(formatMoneyCompact("999950", "USD")).toBe("USD 1M");
    expect(formatMoneyCompact("1386014.00", "USD")).toBe("USD 1.39M");
    expect(formatMoneyCompact("1400000", "USD")).toBe("USD 1.4M");
    expect(formatMoneyCompact("15249000", "USD")).toBe("USD 15.2M");
    expect(formatMoneyCompact("150000000.00", "USD")).toBe("USD 150M");
    expect(formatMoneyCompact("2500000000", "USD")).toBe("USD 2.5B");
    expect(formatMoneyCompact("-1200.5", "USD")).toBe("-USD 1.2k");
  });
});
