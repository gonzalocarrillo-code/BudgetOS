const WARMUP_MS = 400;
const SAMPLE_MS = 1600;
const SCROLL_STEP = 720;

declare global {
  interface Window {
    __gridSpikeMeasure?: () => Promise<number>;
  }
}

function waitForScroller(select: () => HTMLElement | null): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = (): void => {
      const element = select();
      if (element) {
        resolve(element);
        return;
      }
      if (performance.now() - started > 5000) {
        reject(new Error("grid spike scroller was not mounted"));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function pump(scroller: HTMLElement, durationMs: number, record: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) {
      reject(new Error("grid spike scroller has no overflow"));
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
          reject(new Error("grid spike scroller did not move"));
          return;
        }
        if (!record) {
          resolve(0);
          return;
        }
        deltas.sort((left, right) => left - right);
        const mid = deltas[Math.floor(deltas.length / 2)];
        if (mid === undefined || mid <= 0) {
          reject(new Error("grid spike produced no frames"));
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

export function installScrollMeasure(selectScroller: () => HTMLElement | null): void {
  window.__gridSpikeMeasure = async () => {
    const scroller = await waitForScroller(selectScroller);
    await pump(scroller, WARMUP_MS, false);
    return pump(scroller, SAMPLE_MS, true);
  };
}
