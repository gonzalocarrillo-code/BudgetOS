import { describe, expect, it } from "vitest";
import { resolvePeriod } from "./period.js";

describe("resolvePeriod", () => {
  it("resolves relative presets on the calendar year", () => {
    const r = (preset: string) => resolvePeriod({ kind: "relative", preset } as never, "2026-08-15");
    expect(r("current_month")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(r("current_quarter")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(r("current_year")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(r("ytd")).toEqual({ start: "2026-01-01", end: "2026-08-15" });
    expect(r("last_30_days")).toEqual({ start: "2026-07-17", end: "2026-08-15" });
    expect(r("last_90_days")).toEqual({ start: "2026-05-18", end: "2026-08-15" });
    expect(r("next_90_days")).toEqual({ start: "2026-08-15", end: "2026-11-12" });
  });

  it("follows the fiscal year start month", () => {
    // FY starts in April: 2026-02-10 is in FY2025 (2025-04-01 … 2026-03-31), fiscal Q4.
    expect(resolvePeriod({ kind: "relative", preset: "current_year" }, "2026-02-10", 4)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(resolvePeriod({ kind: "relative", preset: "current_quarter" }, "2026-02-10", 4)).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(resolvePeriod({ kind: "relative", preset: "ytd" }, "2026-02-10", 4)).toEqual({ start: "2025-04-01", end: "2026-02-10" });
    expect(resolvePeriod({ kind: "fiscal", key: "FY2026" }, "2026-02-10", 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(resolvePeriod({ kind: "fiscal", key: "2026-Q4" }, "2026-02-10", 4)).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(resolvePeriod({ kind: "fiscal", key: "2024-02" }, "2026-02-10", 4)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });

  it("refuses bad input", () => {
    expect(() => resolvePeriod({ kind: "fiscal", key: "Q3" }, "2026-02-10")).toThrow(/unknown fiscal period/);
    expect(() => resolvePeriod({ kind: "range", start: "2026-02-01", end: "2026-01-01" }, "2026-02-10")).toThrow(/after its end/);
    expect(() => resolvePeriod({ kind: "relative", preset: "ytd" }, "2026-2-1")).toThrow(/yyyy-MM-dd/);
  });
});
