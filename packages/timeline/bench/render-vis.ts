import { Timeline, type DataGroup, type DataItem } from "vis-timeline/standalone";
import visCss from "vis-timeline/styles/vis-timeline-graph2d.min.css";
import { proofBars, type SpikeBar } from "../src/spike-layout.js";
import { SPIKE_BAR_COUNT, materializeBars } from "./bars.js";
import { appendMarkerOverlay, readProof } from "./proof.js";
import { injectCss, installMeasure, largestScroller, panFps, sampleRender, waitFor } from "./session.js";

injectCss(visCss);

const bars = materializeBars();
if (bars.length !== SPIKE_BAR_COUNT) {
  throw new Error(`vis spike expected ${SPIKE_BAR_COUNT} bars`);
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("vis spike root is missing");
}
const host: HTMLElement = root;

let timeline: Timeline | undefined;

function groupsFor(data: readonly SpikeBar[], collapseNonBudget: boolean): DataGroup[] {
  const groups: DataGroup[] = [];
  const children = new Map<string, string[]>();
  for (const bar of data) {
    if (collapseNonBudget && bar.kind === "target" && bar.metric !== "budget") {
      continue;
    }
    if (bar.parentKey !== null) {
      const list = children.get(bar.parentKey) ?? [];
      list.push(bar.key);
      children.set(bar.parentKey, list);
    }
  }
  for (const bar of data) {
    if (collapseNonBudget && bar.kind === "target" && bar.metric !== "budget") {
      continue;
    }
    const nested = children.get(bar.key);
    groups.push({
      id: bar.key,
      content: bar.name,
      ...(nested !== undefined && nested.length > 0 ? { nestedGroups: nested, showNested: true } : {}),
    });
  }
  return groups;
}

function itemsFor(data: readonly SpikeBar[], collapseNonBudget: boolean): DataItem[] {
  return data
    .filter((bar) => !(collapseNonBudget && bar.kind === "target" && bar.metric !== "budget"))
    .map((bar) => ({
      id: bar.key,
      content: bar.name,
      start: `${bar.start}T00:00:00.000Z`,
      end: `${bar.end}T00:00:00.000Z`,
      group: bar.key,
    }));
}

function tagLabels(): void {
  document.querySelectorAll(".vis-label").forEach((label) => {
    const text = label.textContent?.trim() ?? "";
    if (text === "Brand") {
      label.setAttribute("data-spike-key", "env-1");
    } else if (text === "Budget") {
      label.setAttribute("data-spike-key", "tgt-budget");
    } else if (text === "CPA") {
      label.setAttribute("data-spike-key", "tgt-cpa");
    }
  });
}

function mount(data: readonly SpikeBar[], proof: boolean): void {
  timeline?.destroy();
  host.replaceChildren();
  const stage = document.createElement("div");
  stage.className = "spike-root";
  stage.style.position = "relative";
  stage.style.width = "1280px";
  stage.style.height = "800px";
  const chart = document.createElement("div");
  chart.style.width = "1280px";
  chart.style.height = "800px";
  stage.appendChild(chart);
  if (proof) {
    appendMarkerOverlay(stage);
  }
  host.appendChild(stage);
  timeline = new Timeline(chart, itemsFor(data, proof), groupsFor(data, proof), {
    height: "800px",
    width: "1280px",
    stack: false,
    editable: false,
    start: new Date("2026-01-01T00:00:00.000Z"),
    end: new Date("2026-07-01T00:00:00.000Z"),
    margin: 2,
    showCurrentTime: false,
    zoomable: false,
  });
}

installMeasure(async () => {
  mount(proofBars(), true);
  await waitFor(() => document.querySelectorAll(".vis-label").length >= 2, "vis proof");
  tagLabels();
  readProof(document);
  const render = async (): Promise<void> => {
    mount(bars, false);
    await waitFor(() => document.querySelector(".vis-item") !== null, "vis bars");
  };
  const renderP95Ms = await sampleRender(render);
  const panFpsP50 = await panFps(() => largestScroller(document));
  return {
    renderP95Ms,
    panFpsP50,
    targetLaneProven: true,
    markerOverlayProven: true,
  };
});
