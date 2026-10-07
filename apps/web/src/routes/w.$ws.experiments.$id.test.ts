import { describe, expect, it } from "vitest";
import { DetailSearch } from "./w.$ws.experiments.$id.js";

/**
 * EX-4: the experiment detail page's metric choosers (the results table's multi-select and the
 * chart's own chooser) live in the URL via `validateSearch`, not component state or localStorage.
 * `metrics`/`chartMetric` round-trip through the search schema exactly as TanStack Router would
 * parse/serialize them, and are absent (not defaulted here) until the user picks something — the
 * default (spend + the primary metric) is computed where the experiment is known, in SidesPanel.
 */
describe("experiment detail route: metric chooser search params", () => {
  it("round-trips a chosen set of table metrics and a chart metric", () => {
    const raw = { metrics: ["spend", "cpa", "roas"], chartMetric: "roas" };
    const parsed = DetailSearch.parse(raw);
    expect(parsed).toEqual(raw);
    // A second parse of the already-parsed value is unchanged (idempotent, as URL round-trips must be).
    expect(DetailSearch.parse(parsed)).toEqual(parsed);
  });

  it("leaves both choosers unset when absent from the URL, rather than inventing a default here", () => {
    const parsed = DetailSearch.parse({});
    expect(parsed.metrics).toBeUndefined();
    expect(parsed.chartMetric).toBeUndefined();
  });

  it("a single-metric table selection round-trips too", () => {
    const parsed = DetailSearch.parse({ metrics: ["spend"] });
    expect(parsed.metrics).toEqual(["spend"]);
  });

  it("rejects a non-array metrics value", () => {
    expect(DetailSearch.safeParse({ metrics: "cpa" }).success).toBe(false);
  });
});
