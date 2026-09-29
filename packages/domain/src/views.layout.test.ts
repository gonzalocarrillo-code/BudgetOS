import { describe, expect, it } from "vitest";
import { OVERVIEW_BLOCKS, readOverviewLayout } from "./index.js";

/** HO-015: a saved Overview layout reads the same after the Overview's rebuild; old keys map over. */
describe("the Overview's saved layout", () => {
  it("maps the first Overview's keys, and drops the tiles that moved to Home", () => {
    const l = readOverviewLayout({ hidden: ["heatmap", "tile.alerts", "tile.spent", "freshness", "approvals"] });
    expect(l.hidden.sort()).toEqual(["data", "headline.spent", "heatmap", "queue"]);
  });

  it("hides Needs attention only when both pace lists were hidden", () => {
    expect(readOverviewLayout({ hidden: ["overPace"] }).hidden).toEqual([]);
    expect(readOverviewLayout({ hidden: ["overPace", "underPace"] }).hidden).toEqual(["attention"]);
  });

  it("keeps the saved order first and adds every other block in the default order", () => {
    expect(readOverviewLayout({ order: ["kpi", "heatmap", "nope"] }).order).toEqual(["kpi", "heatmap", "headline", "attention", "alerts", "queue", "data"]);
    expect(readOverviewLayout(undefined).order).toEqual([...OVERVIEW_BLOCKS]);
  });

  it("keeps the axes and the sort; anything malformed reads as the default", () => {
    expect(readOverviewLayout({ axes: { rows: "region", cols: "objective" }, sort: "ahead" })).toMatchObject({ axes: { rows: "region", cols: "objective" }, sort: "ahead" });
    expect(readOverviewLayout({ axes: "x", sort: 3 })).toMatchObject({ hidden: [], axes: {} });
  });
});
