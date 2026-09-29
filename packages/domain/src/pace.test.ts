import { describe, expect, it } from "vitest";
import { ON_PLAN, OPEN_ALERT_STATUSES, PACE_BANDS, paceBand } from "./index.js";

/** HO-001 (docs/HOME_OVERVIEW_PLAN.md §3.3): one set of pace bands and one "open alert" for every screen. */
describe("pace bands", () => {
  it("cover every pace with contiguous bands, upper bound exclusive", () => {
    expect(PACE_BANDS.map((b) => b.key)).toEqual(["under", "low", "on", "high", "over"]);
    expect(paceBand(0)).toBe("under");
    expect(paceBand(0.7999)).toBe("under");
    expect(paceBand(0.8)).toBe("low");
    expect(paceBand("0.9499")).toBe("low");
    expect(paceBand("0.95")).toBe("on");
    expect(paceBand(1)).toBe("on");
    expect(paceBand("1.0499")).toBe("on");
    expect(paceBand("1.05")).toBe("high");
    expect(paceBand(1.1999)).toBe("high");
    expect(paceBand(1.2)).toBe("over");
    expect(paceBand("7.5")).toBe("over");
  });

  it("has no band without a pace", () => {
    expect(paceBand(null)).toBeNull();
    expect(paceBand(undefined)).toBeNull();
    expect(paceBand("")).toBeNull();
    expect(paceBand("not a number")).toBeNull();
  });

  it("on plan is the middle band", () => {
    const on = PACE_BANDS.find((b) => b.key === "on");
    const low = PACE_BANDS.find((b) => b.key === "low");
    expect(ON_PLAN).toEqual({ from: low?.max, to: on?.max });
  });

  it("an alert is open until it is snoozed or resolved", () => {
    expect([...OPEN_ALERT_STATUSES]).toEqual(["OPEN", "ACKNOWLEDGED"]);
  });
});
