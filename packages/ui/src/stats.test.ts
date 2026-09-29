import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AsOfChip, HeadlineStrip, PACE_TONES, PaceBar, PaceLegend, StatTile } from "./stats.js";

/** HO-002: the shared pieces draw what they are given, and say it to screen readers. */
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("PaceBar", () => {
  it("fills to the share spent, ticks at the time gone, and takes the band's colour", () => {
    const out = html(createElement(PaceBar, { spent: 0.47, elapsed: 0.6658, band: "low", pace: 0.71 }));
    expect(out).toContain('data-band="low"');
    expect(out).toContain("width:47.0%");
    expect(out).toContain("left:66.6%");
    expect(out).toContain("bg-pace-low-text");
    expect(out).toContain('aria-label="47% spent, 67% of the time gone, pace 0.71"');
  });

  it("stops the fill at the end and marks an overspent budget", () => {
    const out = html(createElement(PaceBar, { spent: 1.3, elapsed: 0.5, band: "over" }));
    expect(out).toContain("width:100.0%");
    expect(out).toContain('data-part="over"');
  });

  it("with no pace, draws a neutral bar and no tick", () => {
    const out = html(createElement(PaceBar, { spent: null, elapsed: null, band: null }));
    expect(out).toContain('data-band="none"');
    expect(out).not.toContain('data-part="tick"');
    expect(out).toContain('aria-label="— spent, — of the time gone"');
  });
});

describe("PaceLegend", () => {
  it("lists the five bands in order, with their words", () => {
    const out = html(createElement(PaceLegend, { testId: "legend" }));
    const order = [...out.matchAll(/data-band="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual([...PACE_TONES]);
    expect(out).toContain("0.95–1.05 on plan");
  });
});

describe("StatTile", () => {
  it("shows the compact value, keeps the exact one for the tooltip and screen readers", () => {
    const out = html(createElement(StatTile, { label: "Budget", value: "1.39M", exact: "USD 1,386,014.00", unit: "USD", testId: "tile-budget" }));
    expect(out).toContain('title="USD 1,386,014.00"');
    expect(out).toContain('<span class="sr-only">USD 1,386,014.00</span>');
    expect(out).toContain('aria-hidden="true">1.39M</span>');
  });
});

describe("HeadlineStrip", () => {
  it("puts every item on one line with its label", () => {
    const out = html(createElement(HeadlineStrip, { title: "Golden this year", items: [{ key: "b", value: "USD 1.39M", label: "budget", exact: "USD 1,386,014.00" }, { key: "a", value: "191", label: "open alerts" }] }));
    expect(out).toContain("Golden this year");
    expect(out).toContain("USD 1.39M");
    expect(out).toContain("open alerts");
  });
});

describe("AsOfChip", () => {
  it("names the last day the actuals cover, neutral while current", () => {
    const out = html(createElement(AsOfChip, { through: "2026-08-31", stale: false, staleDays: 29, grain: "month" }));
    expect(out).toContain("Actuals through");
    expect(out).toMatch(/Aug/);
    expect(out).toContain('data-stale="false"');
    expect(out).toContain("bg-neutral-soft");
    expect(out).not.toContain("days old");
  });

  it("turns to the warning tone and says how old once stale", () => {
    const out = html(createElement(AsOfChip, { through: "2026-09-20", stale: true, staleDays: 9, grain: "day" }));
    expect(out).toContain("bg-warning-soft");
    expect(out).toContain("9 days old");
  });

  it("says there are no actuals yet", () => {
    expect(html(createElement(AsOfChip, { through: null, stale: false, staleDays: null }))).toContain("No actuals yet");
  });
});
