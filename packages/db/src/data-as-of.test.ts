import { describe, expect, it } from "vitest";
import { MONTHLY_GRACE_DAYS, STALE_AFTER_DAYS, coverage, endOfMonth } from "./data-as-of.js";

/** HO-003 (ADR-062): how far the actuals go, and when they are stale. */
describe("coverage of the latest actuals", () => {
  it("a monthly source covers its whole month (the golden: August rows dated the 1st)", () => {
    expect(coverage("2026-08-01", ["yyyy-MM"], "2026-09-29")).toEqual({ lastFactDate: "2026-08-01", through: "2026-08-31", grain: "month", staleDays: 29, stale: false });
  });

  it("a daily source covers its day", () => {
    expect(coverage("2026-09-28", ["yyyy-MM-dd"], "2026-09-29")).toMatchObject({ through: "2026-09-28", grain: "day", staleDays: 1, stale: false });
  });

  it("any daily source on the latest date makes it daily; no format reads as daily", () => {
    expect(coverage("2026-09-01", ["yyyy-MM", "yyyy-MM-dd"], "2026-09-29")).toMatchObject({ through: "2026-09-01", grain: "day" });
    expect(coverage("2026-09-01", [null], "2026-09-29")).toMatchObject({ grain: "day" });
    expect(coverage("2026-09-01", [], "2026-09-29")).toMatchObject({ grain: "day" });
  });

  it("never runs past today: a month loaded while it is still running covers up to today", () => {
    expect(coverage("2026-09-01", ["yyyy-MM"], "2026-09-15")).toMatchObject({ through: "2026-09-15", staleDays: 0, stale: false });
  });

  it(`a daily source is stale when more than ${STALE_AFTER_DAYS} days behind`, () => {
    expect(coverage("2026-09-27", ["yyyy-MM-dd"], "2026-09-29").stale).toBe(false);
    expect(coverage("2026-09-26", ["yyyy-MM-dd"], "2026-09-29")).toMatchObject({ staleDays: 3, stale: true });
  });

  it(`a monthly source is stale when last month is still missing ${MONTHLY_GRACE_DAYS} days after it ended`, () => {
    // On 5 Oct, September may still be on its way; on 11 Oct it is late.
    expect(coverage("2026-08-01", ["yyyy-MM"], "2026-10-05").stale).toBe(false);
    expect(coverage("2026-08-01", ["yyyy-MM"], "2026-10-11")).toMatchObject({ through: "2026-08-31", staleDays: 41, stale: true });
    // July's rows on 29 Sep: August is missing past its grace.
    expect(coverage("2026-07-01", ["yyyy-MM"], "2026-09-29").stale).toBe(true);
  });

  it("no actuals: nothing to be stale", () => {
    expect(coverage(null, [], "2026-09-29")).toEqual({ lastFactDate: null, through: null, grain: null, staleDays: null, stale: false });
  });

  it("knows how long months are", () => {
    expect([endOfMonth("2026-02-01"), endOfMonth("2028-02-10"), endOfMonth("2026-12-01"), endOfMonth("2026-04-30")]).toEqual(["2026-02-28", "2028-02-29", "2026-12-31", "2026-04-30"]);
  });
});
