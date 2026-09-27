import { fiscalPeriods, type TimelineBar } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { cellWidthFor, chartRange, fiscalScales, fiscalUnit, fiscalUnitStart, fromLocal, isoWeek, toLocal } from "./fiscal-scales.js";
import { CLUSTER_PX, clusterKind, dateAtX, placeMarkers } from "./overlay.js";
import { toSvarTasks } from "./tasks.js";

/** T-037 (spec §23.2): the adapter's pure parts — fiscal units and labels, SVAR tasks, the marker overlay. */

const calendar = (fyStart: number, from = "2026-01-01", to = "2026-12-31", zoom: "month" | "week" = "month") => ({ fiscalYearStartMonth: fyStart, periods: fiscalPeriods(from, to, fyStart, zoom), keyDates: [] });
const fmt = (s: { format?: unknown }, d: Date) => (typeof s.format === "function" ? (s.format as (d: Date) => string)(d) : String(s.format));

describe("fiscal scales", () => {
  it("January fiscal years use SVAR's own units; labels come from the calendar's periods", () => {
    expect([fiscalUnit("fy", 1), fiscalUnit("fq", 1)]).toEqual(["year", "quarter"]);
    const [quarter, month] = fiscalScales("month", calendar(1));
    expect(quarter?.unit).toBe("quarter");
    expect(fmt(quarter as object, toLocal("2026-10-01"))).toBe("Q4 FY2026");
    expect(fmt(month as object, toLocal("2026-10-01"))).toBe("Oct");
    const [fy, q] = fiscalScales("quarter", calendar(1));
    expect([fmt(fy as object, toLocal("2026-05-01")), fmt(q as object, toLocal("2026-05-01"))]).toEqual(["FY2026", "Q2"]);
  });

  it("an April fiscal year: SVAR quarters line up, the year is a registered unit starting in April", () => {
    expect(fiscalUnit("fq", 4)).toBe("quarter");
    const fy = fiscalUnit("fy", 4);
    expect(fy).toBe("fy4");
    expect(fromLocal(fiscalUnitStart("fy", 4, toLocal("2026-02-10")))).toBe("2025-04-01");
    expect(fromLocal(fiscalUnitStart("fy", 4, toLocal("2026-04-01")))).toBe("2026-04-01");
    const [year, q] = fiscalScales("quarter", calendar(4, "2026-01-01", "2026-06-30"));
    expect(year?.unit).toBe("fy4");
    expect(fmt(q as object, toLocal("2026-02-01"))).toBe("Q4");
    expect(fmt(year as object, toLocal("2026-05-01"))).toBe("FY2026");
  });

  it("a February fiscal year registers its own quarter unit", () => {
    const fq = fiscalUnit("fq", 2);
    expect(fq).toBe("fq2");
    expect(fromLocal(fiscalUnitStart("fq", 2, toLocal("2026-01-15")))).toBe("2025-11-01");
    expect(fromLocal(fiscalUnitStart("fq", 2, toLocal("2026-02-01")))).toBe("2026-02-01");
    const [quarter] = fiscalScales("month", calendar(2));
    expect(fmt(quarter as object, toLocal("2026-03-01"))).toBe("Q1 FY2026");
  });

  it("weeks are ISO weeks; the chart spans whole months; cell widths per zoom", () => {
    expect(isoWeek(toLocal("2025-12-29"))).toBe(1);
    expect(isoWeek(toLocal("2025-12-28"))).toBe(1); // a Sunday cell: the ISO week it shares six days with
    expect(isoWeek(toLocal("2026-09-26"))).toBe(39);
    expect(chartRange(calendar(1))).toEqual({ start: toLocal("2026-01-01"), end: toLocal("2027-01-01") });
    expect(new Set(["week", "month", "quarter", "fy"].map((z) => cellWidthFor(z as "week")).map((w) => w > 0))).toEqual(new Set([true]));
  });
});

const bar = (over: Partial<TimelineBar>): TimelineBar => ({ key: "k", parentKey: null, level: 0, kind: "group", name: "n", path: [], start: "2026-01-01", end: "2026-12-31", paceState: "none", hasChildren: false, expanded: false, lane: 0, markers: [], ...over });

describe("SVAR tasks", () => {
  const bars = [
    bar({ key: "BR", kind: "group", hasChildren: true, expanded: true }),
    bar({ key: "e1", parentKey: "BR", level: 1, kind: "envelope", hasChildren: true, spendPct: 0.5 }),
    bar({ key: "e1:cpa", parentKey: "e1", level: 2, kind: "target", metric: "cpa", start: "2026-10-01" }),
    bar({ key: "e2", parentKey: "BR", level: 1, kind: "envelope", hasChildren: true }),
    bar({ key: "e2:budget", parentKey: "e2", level: 2, kind: "target", metric: "budget" }),
    bar({ key: "e2:roas", parentKey: "e2", level: 2, kind: "target", metric: "roas" }),
    bar({ key: "e3", parentKey: "MX", level: 1, kind: "envelope" }), // parent not loaded
  ];

  it("collapsed envelopes pass only budget-target rows and are lazy when they have others; ends are exclusive", () => {
    const tasks = toSvarTasks(bars, new Set());
    expect(tasks.map((t) => t.id)).toEqual(["BR", "e1", "e2", "e2:budget"]);
    const e1 = tasks.find((t) => t.id === "e1");
    expect(e1).toMatchObject({ parent: "BR", lazy: true, progress: 50, type: "envelope" });
    expect(e1?.open).toBeUndefined(); // ADR-003: never `open` without children
    expect(tasks.find((t) => t.id === "e2")).toMatchObject({ open: true });
    expect(tasks.find((t) => t.id === "BR")).toMatchObject({ parent: 0, open: true });
    expect(fromLocal(tasks[0]?.end as Date)).toBe("2027-01-01");
  });

  it("experiment lanes (T-038) are children of their envelope, shown when it is opened", () => {
    const withExperiment = [...bars, bar({ key: "e1:x:1", parentKey: "e1", level: 2, kind: "experiment", experimentId: "01927a00-0000-7000-8000-0000000000aa", status: "RUNNING · TEST" })];
    expect(toSvarTasks(withExperiment, new Set()).some((t) => t.id === "e1:x:1")).toBe(false);
    expect(toSvarTasks(withExperiment, new Set(["e1"])).find((t) => t.id === "e1:x:1")).toMatchObject({ parent: "e1", type: "experiment" });
  });

  it("opening an envelope passes all of its target lanes", () => {
    const tasks = toSvarTasks(bars, new Set(["e1", "e2"]));
    expect(tasks.map((t) => t.id)).toEqual(["BR", "e1", "e1:cpa", "e2", "e2:budget", "e2:roas"]);
    expect(tasks.find((t) => t.id === "e1")).toMatchObject({ open: true });
    expect(tasks.find((t) => t.id === "e1")?.lazy).toBeUndefined();
  });
});

describe("marker overlay", () => {
  const x = (d: string) => (Date.parse(`${d}T00:00:00Z`) - Date.parse("2026-01-01T00:00:00Z")) / 86_400_000 * 3; // 3 px a day

  it("markers under 6 px apart on a row share a cluster; the cluster shows its most important kind", () => {
    const clusters = placeMarkers(
      [
        { key: "e1", y: 36, markers: [{ kind: "comment", at: "2026-02-02", id: "c" }, { kind: "approval", at: "2026-02-01", id: "a" }, { kind: "alert", at: "2026-03-01", id: "x" }] },
        { key: "e2", y: 72, markers: [] },
      ],
      x,
    );
    expect(clusters.map((c) => [c.rowKey, c.markers.map((m) => m.id), c.y])).toEqual([
      ["e1", ["a", "c"], 36],
      ["e1", ["x"], 36],
    ]);
    expect(clusters[0]?.x).toBe(x("2026-02-01"));
    expect(x("2026-02-02") - x("2026-02-01")).toBeLessThan(CLUSTER_PX);
    expect(clusterKind(clusters[0] as never)).toBe("approval");
  });

  it("the scrubber maps an x back to the nearest day", () => {
    expect(dateAtX(x("2026-05-08") + 1, "2026-01-01", "2026-12-31", x)).toBe("2026-05-08");
    expect(dateAtX(-50, "2026-01-01", "2026-12-31", x)).toBe("2026-01-01");
    expect(dateAtX(99_999, "2026-01-01", "2026-12-31", x)).toBe("2026-12-31");
  });
});
