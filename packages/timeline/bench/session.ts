export interface EngineSample {
  renderP95Ms: number;
  panFpsP50: number;
  targetLaneProven: boolean;
  markerOverlayProven: boolean;
}

declare global {
  interface Window {
    __timelineSpikeMeasure?: () => Promise<EngineSample>;
    __timelineSpikeError?: string;
  }
}

const WARMUP_MS = 400;
const SAMPLE_MS = 1_600;
const SCROLL_STEP = 720;
const RENDER_SAMPLES = 7;

function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function waitFor(ready: () => boolean, label: string): Promise<void> {
  const started = performance.now();
  while (!ready()) {
    if (performance.now() - started > 20_000) {
    throw new Error(
      `${label} did not paint; error=${window.__timelineSpikeError ?? ""}; text=${document.body.innerText.slice(0, 300)}; bars=${document.querySelectorAll(".wx-bar").length}; tasks=${document.querySelectorAll("[data-task-id]").length}; labels=${document.querySelectorAll(".vis-label").length}`,
    );
    }
    await frame();
  }
  await frame();
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("render bench produced no samples");
  }
  return value;
}

export async function sampleRender(mount: () => Promise<void>): Promise<number> {
  await mount();
  const samples: number[] = [];
  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const start = performance.now();
    await mount();
    samples.push(performance.now() - start);
  }
  return percentile95(samples);
}

export function largestScroller(root: ParentNode): HTMLElement | null {
  let best: HTMLElement | null = null;
  let overflow = 0;
  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    const extra = element.scrollHeight - element.clientHeight;
    if (extra > overflow && element.clientHeight > 0) {
      overflow = extra;
      best = element;
    }
  });
  return best;
}

function pump(scroller: HTMLElement, durationMs: number, record: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) {
      reject(new Error("timeline spike scroller has no overflow"));
      return;
    }
    const deltas: number[] = [];
    let last = performance.now();
    const started = last;
    let moved = false;
    let previous = scroller.scrollTop;
    let nextTop = previous;
    const onFrame = (now: number): void => {
      if (record) {
        deltas.push(now - last);
      }
      last = now;
      if (now - started >= durationMs) {
        if (!moved) {
          reject(new Error("timeline spike scroller did not move"));
          return;
        }
        if (!record) {
          resolve(0);
          return;
        }
        deltas.sort((left, right) => left - right);
        const mid = deltas[Math.floor(deltas.length / 2)];
        if (mid === undefined || mid <= 0) {
          reject(new Error("timeline spike produced no frames"));
          return;
        }
        resolve(1000 / mid);
        return;
      }
      nextTop += SCROLL_STEP;
      if (nextTop > max) {
        nextTop = 0;
      }
      scroller.scrollTop = nextTop;
      if (scroller.scrollTop !== previous) {
        moved = true;
      }
      previous = scroller.scrollTop;
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}

export async function panFps(select: () => HTMLElement | null): Promise<number> {
  const started = performance.now();
  let scroller = select();
  while (scroller === null) {
    if (performance.now() - started > 5_000) {
      throw new Error("timeline spike scroller was not mounted");
    }
    await frame();
    scroller = select();
  }
  await pump(scroller, WARMUP_MS, false);
  return pump(scroller, SAMPLE_MS, true);
}

export function installMeasure(run: () => Promise<EngineSample>): void {
  window.__timelineSpikeMeasure = run;
}

export function injectCss(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
