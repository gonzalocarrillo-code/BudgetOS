import { describe, expect, it } from "vitest";
import { fiscalYearPeriods, resolvePeriod, type CalendarPeriod } from "./period.js";

/** Product feedback 7 (ADR-041): what a quarter is comes from the workspace's own calendar. */

describe("fiscalYearPeriods", () => {
  it("calendar: FY, four 3-month quarters, twelve calendar months from the start month", () => {
    const p = fiscalYearPeriods(2027, 7, "calendar");
    expect(p.find((x) => x.key === "FY2027")).toEqual({ key: "FY2027", kind: "year", start: "2027-07-01", end: "2028-06-30" });
    expect(p.filter((x) => x.kind === "quarter").map((x) => [x.key, x.start, x.end])).toEqual([
      ["2027-Q1", "2027-07-01", "2027-09-30"],
      ["2027-Q2", "2027-10-01", "2027-12-31"],
      ["2027-Q3", "2028-01-01", "2028-03-31"],
      ["2027-Q4", "2028-04-01", "2028-06-30"],
    ]);
    expect(p.filter((x) => x.kind === "month").map((x) => x.key)).toEqual(["2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12", "2028-01", "2028-02", "2028-03", "2028-04", "2028-05", "2028-06"]);
  });

  it("4-4-5: 13-week quarters of 4, 4 and 5 weeks; the year is covered without gaps", () => {
    const p = fiscalYearPeriods(2026, 1, "445");
    const months = p.filter((x) => x.kind === "month");
    expect(months.slice(0, 3).map((x) => [x.key, x.start, x.end])).toEqual([
      ["FY2026-P01", "2026-01-01", "2026-01-28"],
      ["FY2026-P02", "2026-01-29", "2026-02-25"],
      ["FY2026-P03", "2026-02-26", "2026-04-01"],
    ]);
    expect(p.find((x) => x.key === "2026-Q1")).toMatchObject({ start: "2026-01-01", end: "2026-04-01" });
    expect(p.find((x) => x.key === "2026-Q4")?.end).toBe("2026-12-31");
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    for (let i = 1; i < months.length; i += 1) expect(day((months[i] as CalendarPeriod).start) - day((months[i - 1] as CalendarPeriod).end)).toBe(1);
  });
});

describe("resolvePeriod with the workspace calendar", () => {
  const calendar = fiscalYearPeriods(2026, 1, "445").concat([{ key: "Black Friday 2026", kind: "custom", start: "2026-11-20", end: "2026-11-30" }]);
  it("a key resolves to its row; custom partitions too", () => {
    expect(resolvePeriod({ kind: "fiscal", key: "2026-Q1" }, "2026-05-01", 1, calendar)).toEqual({ start: "2026-01-01", end: "2026-04-01" });
    expect(resolvePeriod({ kind: "fiscal", key: "Black Friday 2026" }, "2026-05-01", 1, calendar)).toEqual({ start: "2026-11-20", end: "2026-11-30" });
  });
  it("'this quarter / month / year' is the row of that kind containing today", () => {
    expect(resolvePeriod({ kind: "relative", preset: "current_quarter" }, "2026-04-01", 1, calendar)).toEqual({ start: "2026-01-01", end: "2026-04-01" }); // 4-4-5: 1 April is still Q1
    expect(resolvePeriod({ kind: "relative", preset: "current_quarter" }, "2026-04-02", 1, calendar).start).toBe("2026-04-02");
    expect(resolvePeriod({ kind: "relative", preset: "current_month" }, "2026-01-29", 1, calendar)).toEqual({ start: "2026-01-29", end: "2026-02-25" });
    expect(resolvePeriod({ kind: "relative", preset: "ytd" }, "2026-06-15", 1, calendar)).toEqual({ start: "2026-01-01", end: "2026-06-15" });
  });
  it("without a row, the computed rule as before", () => {
    expect(resolvePeriod({ kind: "relative", preset: "current_quarter" }, "2027-05-10", 1, calendar)).toEqual({ start: "2027-04-01", end: "2027-06-30" });
    expect(resolvePeriod({ kind: "fiscal", key: "2025-Q3" }, "2026-05-01", 1, calendar)).toEqual({ start: "2025-07-01", end: "2025-09-30" });
  });
});
