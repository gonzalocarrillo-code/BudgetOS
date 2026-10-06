import { describe, expect, it } from "vitest";
import { todayIso } from "./dates.js";

describe("todayIso", () => {
  it("returns the UTC date as ISO string YYYY-MM-DD", () => {
    expect(todayIso(new Date("2026-03-02T00:00:00Z"))).toBe("2026-03-02");
  });

  it("west of UTC in the evening returns tomorrow's UTC date", () => {
    // 2026-03-01 23:30:00 -05:00 = 2026-03-02 04:30:00 UTC
    expect(todayIso(new Date("2026-03-01T23:30:00-05:00"))).toBe("2026-03-02");
  });

  it("east of UTC in the morning returns yesterday's UTC date", () => {
    // 2026-03-02 00:30:00 +05:00 = 2026-03-01 19:30:00 UTC
    expect(todayIso(new Date("2026-03-02T00:30:00+05:00"))).toBe("2026-03-01");
  });
});
