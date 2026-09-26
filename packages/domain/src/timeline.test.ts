import { describe, expect, it } from "vitest";
import { effectiveSegments, effectiveTargetAt, fiscalPeriods, paceStateOf, stackLanes, type LaneTarget } from "./timeline.js";

describe("timeline helpers (T-037)", () => {
  it("fiscal periods follow the workspace's fiscal year; ids are the planner's fiscal keys", () => {
    const jan = fiscalPeriods("2026-01-01", "2026-12-31", 1, "month");
    expect(jan.filter((p) => p.kind === "fy").map((p) => p.id)).toEqual(["FY2026"]);
    expect(jan.filter((p) => p.kind === "quarter").map((p) => [p.id, p.start, p.end])).toEqual([
      ["2026-Q1", "2026-01-01", "2026-03-31"],
      ["2026-Q2", "2026-04-01", "2026-06-30"],
      ["2026-Q3", "2026-07-01", "2026-09-30"],
      ["2026-Q4", "2026-10-01", "2026-12-31"],
    ]);
    expect(jan.filter((p) => p.kind === "month")).toHaveLength(12);
    const apr = fiscalPeriods("2026-01-01", "2026-06-30", 4, "quarter");
    expect(apr.filter((p) => p.kind === "fy").map((p) => [p.id, p.start, p.end])).toEqual([
      ["FY2025", "2025-04-01", "2026-03-31"],
      ["FY2026", "2026-04-01", "2027-03-31"],
    ]);
    expect(apr.filter((p) => p.kind === "quarter").map((p) => p.label)).toEqual(["Q4 FY2025", "Q1 FY2026"]);
    expect(apr.some((p) => p.kind === "week")).toBe(false);
    const weeks = fiscalPeriods("2026-01-01", "2026-01-31", 1, "week").filter((p) => p.kind === "week");
    expect(weeks[0]).toMatchObject({ id: "2026-W01", start: "2025-12-29", end: "2026-01-04" });
    expect(weeks).toHaveLength(5);
  });

  const annual: LaneTarget = { id: "annual", metric: "cpa", start: "2026-01-01", end: "2026-12-31", depth: 0 };
  const q4: LaneTarget = { id: "q4", metric: "cpa", start: "2026-10-01", end: "2026-12-31", depth: 0 };
  const inherited: LaneTarget = { id: "country", metric: "cpa", start: "2026-01-01", end: "2026-12-31", depth: 1 };
  const roas: LaneTarget = { id: "roas", metric: "roas", start: "2026-01-01", end: "2026-12-31", depth: 0 };

  it("an annual CPA target with a Q4 override: two lanes; the override is effective in Q4, the annual elsewhere", () => {
    const lanes = stackLanes([q4, annual, roas]);
    expect([lanes.get("annual"), lanes.get("q4"), lanes.get("roas")]).toEqual([0, 1, 0]);
    expect(effectiveTargetAt([annual, q4], "cpa", "2026-09-30")?.id).toBe("annual");
    expect(effectiveTargetAt([annual, q4], "cpa", "2026-10-01")?.id).toBe("q4");
    expect(effectiveTargetAt([annual, q4], "roas", "2026-10-01")).toBeNull();
    const segs = effectiveSegments([annual, q4, roas]);
    expect(segs.get("annual")).toEqual([{ start: "2026-01-01", end: "2026-09-30" }]);
    expect(segs.get("q4")).toEqual([{ start: "2026-10-01", end: "2026-12-31" }]);
    expect(segs.get("roas")).toEqual([{ start: "2026-01-01", end: "2026-12-31" }]);
  });

  it("an own target beats an inherited one even when the inherited one is narrower", () => {
    const narrowParent: LaneTarget = { ...inherited, start: "2026-03-01", end: "2026-03-31" };
    expect(effectiveTargetAt([annual, narrowParent], "cpa", "2026-03-15")?.id).toBe("annual");
    const segs = effectiveSegments([q4, inherited]);
    expect(segs.get("country")).toEqual([{ start: "2026-01-01", end: "2026-09-30" }]);
    expect(segs.get("q4")).toEqual([{ start: "2026-10-01", end: "2026-12-31" }]);
  });

  it("an override in the middle splits the outer target's effective range", () => {
    const mid: LaneTarget = { id: "mid", metric: "cpa", start: "2026-05-01", end: "2026-05-31", depth: 0 };
    expect(effectiveSegments([annual, mid]).get("annual")).toEqual([
      { start: "2026-01-01", end: "2026-04-30" },
      { start: "2026-06-01", end: "2026-12-31" },
    ]);
    // Non-overlapping targets share a lane.
    expect(stackLanes([mid, { ...mid, id: "jun", start: "2026-06-01", end: "2026-06-30" }]).get("jun")).toBe(0);
  });

  it("pace state bands", () => {
    expect([null, 0.5, 1, 1.2, 1.4].map(paceStateOf)).toEqual(["none", "under", "on", "over", "critical"]);
  });
});
