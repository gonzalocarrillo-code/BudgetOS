import { markerX, proofBars, visibleLaneRows, type SpikeBar } from "../src/spike-layout.js";
import { SPIKE_BAR_COUNT, materializeBars } from "./bars.js";
import { appendMarkerOverlay, readProof } from "./proof.js";
import { installMeasure, panFps, sampleRender, waitFor } from "./session.js";

const bars = materializeBars();
if (bars.length !== SPIKE_BAR_COUNT) {
  throw new Error(`canvas spike expected ${SPIKE_BAR_COUNT} bars`);
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("canvas spike root is missing");
}
const host: HTMLElement = root;

const SCALE = {
  startMs: Date.parse("2026-01-01T00:00:00.000Z"),
  endMs: Date.parse("2026-07-01T00:00:00.000Z"),
  widthPx: 1000,
};
const ROW_HEIGHT = 36;

let scroller: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;

function paintCanvas(data: readonly SpikeBar[], scrollTop: number): void {
  if (canvas === null) {
    return;
  }
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("canvas spike has no 2d context");
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const end = Math.min(data.length, start + Math.ceil(canvas.height / ROW_HEIGHT) + 1);
  for (let index = start; index < end; index += 1) {
    const bar = data[index];
    if (bar === undefined) {
      continue;
    }
    const x = markerX(SCALE, bar.start);
    const width = Math.max(4, markerX(SCALE, bar.end) - x);
    const y = index * ROW_HEIGHT - scrollTop;
    context.fillStyle = bar.kind === "target" ? "#1f7a4d" : bar.kind === "experiment" ? "#8a5a00" : "#1d4e89";
    context.fillRect(x, y + 6, width, ROW_HEIGHT - 12);
  }
}

function mountProof(): void {
  host.replaceChildren();
  const stage = document.createElement("div");
  stage.className = "spike-root";
  stage.style.position = "relative";
  stage.style.width = "1280px";
  stage.style.height = "800px";
  const surface = document.createElement("canvas");
  surface.width = 1000;
  surface.height = 200;
  stage.appendChild(surface);
  const drawn = visibleLaneRows(proofBars());
  const context = surface.getContext("2d");
  if (context === null) {
    throw new Error("canvas spike has no 2d context");
  }
  for (const row of drawn) {
    const bar = proofBars().find((item) => item.key === row.key);
    if (bar === undefined) {
      continue;
    }
    const x = markerX(SCALE, bar.start);
    const width = Math.max(4, markerX(SCALE, bar.end) - x);
    context.fillStyle = row.kind === "target" ? "#1f7a4d" : "#1d4e89";
    context.fillRect(x, row.lane * ROW_HEIGHT + 6, width, ROW_HEIGHT - 12);
    const hit = document.createElement("div");
    hit.dataset["spikeKey"] = row.key;
    hit.style.position = "absolute";
    hit.style.left = `${x}px`;
    hit.style.top = `${row.lane * ROW_HEIGHT}px`;
    hit.style.width = `${width}px`;
    hit.style.height = `${ROW_HEIGHT}px`;
    stage.appendChild(hit);
  }
  const pixel = context.getImageData(10, 10, 1, 1).data;
  if ((pixel[3] ?? 0) === 0) {
    throw new Error("canvas did not paint the envelope bar");
  }
  appendMarkerOverlay(stage);
  host.appendChild(stage);
}

function mountBars(): void {
  host.replaceChildren();
  const stage = document.createElement("div");
  stage.className = "spike-root";
  stage.style.position = "relative";
  stage.style.width = "1280px";
  stage.style.height = "800px";
  const scroll = document.createElement("div");
  scroll.dataset["spikeScroll"] = "";
  scroll.style.width = "1280px";
  scroll.style.height = "800px";
  scroll.style.overflow = "auto";
  const spacer = document.createElement("div");
  spacer.style.height = `${bars.length * ROW_HEIGHT}px`;
  spacer.style.width = "1px";
  const surface = document.createElement("canvas");
  surface.width = 1000;
  surface.height = 800;
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = "0";
  surface.style.pointerEvents = "none";
  scroll.appendChild(spacer);
  scroll.addEventListener("scroll", () => {
    paintCanvas(bars, scroll.scrollTop);
  });
  stage.appendChild(scroll);
  stage.appendChild(surface);
  host.appendChild(stage);
  scroller = scroll;
  canvas = surface;
  paintCanvas(bars, 0);
}

installMeasure(async () => {
  mountProof();
  await waitFor(() => document.querySelector("[data-spike-key='tgt-budget']") !== null, "canvas proof");
  readProof(document);
  const render = async (): Promise<void> => {
    mountBars();
    await waitFor(() => canvas !== null, "canvas bars");
  };
  const renderP95Ms = await sampleRender(render);
  const panFpsP50 = await panFps(() => scroller);
  return {
    renderP95Ms,
    panFpsP50,
    targetLaneProven: true,
    markerOverlayProven: true,
  };
});
