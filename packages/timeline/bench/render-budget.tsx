import { createRoot, type Root } from "react-dom/client";
import type { TimelineBar, TimelineResponse } from "@budget/domain";
import { fiscalPeriods } from "@budget/domain";
import ganttCss from "@svar-ui/react-gantt/all.css";
import timelineCss from "../src/timeline.css";
import { BudgetTimeline, type BudgetTimelineLabels } from "../src/BudgetTimeline.js";
import { SPIKE_BAR_COUNT } from "./bars.js";
import { injectCss, installMeasure, largestScroller, panFps, sampleRender, waitFor } from "./session.js";

/**
 * T-037 gate (spec §23.2): `BudgetTimeline` itself — fiscal scales, bar templates, the marker
 * overlay, today line and scrubber — renders 5,000 bars in < 500 ms p95. 20 groups, 996 envelopes
 * each with four budget-target lanes (budget lanes are shown without expanding), markers on every
 * 20th envelope. Each sample is a full remount, timed until the bars and the overlay are painted.
 */

injectCss(ganttCss);
injectCss(timelineCss);

const ORIGIN = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (day: number) => new Date(ORIGIN + day * 86_400_000).toISOString().slice(0, 10);

function fiveThousand(): TimelineResponse {
  const bars: TimelineBar[] = [];
  const base = { paceState: "on" as const, hasChildren: false, expanded: false, lane: 0, markers: [] };
  for (let g = 0; g < 20; g += 1) bars.push({ ...base, key: `g${g}`, parentKey: null, level: 0, kind: "group", name: `Group ${g}`, path: [`g${g}`], start: "2026-01-01", end: "2026-12-31", budget: "100000.00", spendPct: 0.5, projectedPct: 0.9, paceIndex: 1, hasChildren: true, expanded: true });
  for (let e = 0; e < 996; e += 1) {
    const key = `e${e}`;
    const start = e % 90;
    bars.push({
      ...base,
      key,
      parentKey: `g${e % 20}`,
      level: 1,
      kind: "envelope",
      name: `Envelope ${e}`,
      path: [`g${e % 20}`, key],
      start: iso(start),
      end: iso(start + 200),
      budget: "1000.00",
      spendPct: (e % 10) / 10,
      projectedPct: 0.8,
      paceIndex: 0.9,
      paceState: e % 3 === 0 ? "over" : "on",
      hasChildren: true,
      markers: e % 20 === 0 ? [{ kind: "approval", at: iso(start + 10), id: `${key}-a` }, { kind: "comment", at: iso(start + 11), id: `${key}-c` }, { kind: "alert", at: iso(start + 60), id: `${key}-x`, severity: "warning" }] : [],
    });
    for (let t = 0; t < 4; t += 1) {
      bars.push({ ...base, key: `${key}:t${t}`, parentKey: key, level: 2, kind: "target", name: "budget", path: [`g${e % 20}`, key, "budget"], start: iso(start + t * 20), end: iso(start + 120 + t * 20), metric: "budget", value: "1000", comparator: "lte", lane: t, effective: [{ start: iso(start + t * 20), end: iso(start + 40 + t * 20) }], paceState: "none" });
    }
  }
  if (bars.length !== SPIKE_BAR_COUNT) throw new Error(`budget bench has ${bars.length} bars`);
  return { bars, levels: [], nextCursor: null, calendar: { fiscalYearStartMonth: 1, periods: fiscalPeriods("2026-01-01", "2026-12-31", 1, "month"), keyDates: [{ at: "2026-04-02", label: "2026-Q1", kind: "closure" }] }, dataVersion: "1", dataAsOf: "2026-09-26T00:00:00.000Z" };
}

const data = fiveThousand();
const labels: BudgetTimelineLabels = { name: "Budget", budget: "Budget", spent: "Spent", today: "Today", asOf: "As of", inherited: "inherited", none: "(none)", marker: { approval: "Approval", alert: "Alert", closure: "Closure", comment: "Comment", version: "Version" } };

const host = document.getElementById("root");
if (host === null) throw new Error("budget bench root is missing");
host.style.width = "1280px";
host.style.height = "800px";
const root: Root = createRoot(host);
let mountKey = 0;

function paint(): void {
  mountKey += 1;
  root.render(
    <div key={mountKey} style={{ width: 1280, height: 800 }}>
      <BudgetTimeline data={data} zoom="month" today="2026-09-26" labels={labels} formatMoney={(a) => a} onOpen={() => undefined} onAsOfChange={() => undefined} />
    </div>,
  );
}

installMeasure(async () => {
  const mount = async (): Promise<void> => {
    root.render(null);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    paint();
    await waitFor(() => document.querySelector("[data-bar-key]") !== null && document.querySelector("[data-testid='timeline-marker']") !== null, "budget timeline");
  };
  const renderP95Ms = await sampleRender(mount);
  // Proofs on the painted chart: a budget-target lane row under its envelope; markers are ours.
  const tasks = Number(document.querySelector("[data-testid='budget-timeline']")?.getAttribute("data-bars") ?? 0);
  const lane = document.querySelector("[data-bar-key='e0:t0']");
  const env = document.querySelector("[data-bar-key='e0']");
  const targetLaneProven = tasks === SPIKE_BAR_COUNT && lane !== null && env !== null && lane.getBoundingClientRect().top > env.getBoundingClientRect().top;
  const markerOverlayProven = document.querySelector(".wx-marker") === null && document.querySelectorAll("[data-testid='timeline-marker']").length > 0;
  const panFpsP50 = await panFps(() => largestScroller(document));
  return { renderP95Ms, panFpsP50, targetLaneProven, markerOverlayProven };
});
