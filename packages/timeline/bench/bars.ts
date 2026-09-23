import type { SpikeBar } from "../src/spike-layout.js";

export const SPIKE_BAR_COUNT = 5_000;

const ORIGIN_MS = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function iso(day: number): string {
  return new Date(ORIGIN_MS + day * DAY_MS).toISOString().slice(0, 10);
}

export function materializeBars(): SpikeBar[] {
  const bars: SpikeBar[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const key = `env-${index}`;
    const startDay = index % 50;
    const markers =
      index % 20 === 0
        ? [
            { id: `${key}-approval`, kind: "approval" as const, at: iso(startDay + 10) },
            { id: `${key}-comment`, kind: "comment" as const, at: iso(startDay + 11) },
          ]
        : [];
    bars.push({
      key,
      parentKey: null,
      kind: "envelope",
      name: `Envelope ${index}`,
      start: iso(startDay),
      end: iso(startDay + 45),
      markers,
    });
    for (const metric of ["budget", "cpa", "roas"] as const) {
      bars.push({
        key: `${key}-${metric}`,
        parentKey: key,
        kind: "target",
        metric,
        name: metric,
        start: iso(startDay + 2),
        end: iso(startDay + 30),
        markers: [],
      });
    }
    bars.push({
      key: `${key}-exp`,
      parentKey: key,
      kind: "experiment",
      name: `Experiment ${index}`,
      start: iso(startDay + 5),
      end: iso(startDay + 20),
      markers: [],
    });
  }
  if (bars.length !== SPIKE_BAR_COUNT) {
    throw new Error(`spike fixture has ${bars.length} bars`);
  }
  return bars;
}
