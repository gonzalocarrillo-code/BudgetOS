export type SpikeKind = "envelope" | "target" | "experiment";

export type MarkerKind = "approval" | "alert" | "closure" | "comment" | "version";

export interface SpikeMarker {
  id: string;
  kind: MarkerKind;
  at: string;
}

export interface SpikeBar {
  key: string;
  parentKey: string | null;
  kind: SpikeKind;
  name: string;
  start: string;
  end: string;
  markers: SpikeMarker[];
  metric?: string;
}

export interface LaneRow {
  key: string;
  parentKey: string | null;
  kind: SpikeKind;
  lane: number;
}

export interface TimeScale {
  startMs: number;
  endMs: number;
  widthPx: number;
}

export interface SvarTask {
  id: string;
  parent: string | number;
  text: string;
  start: Date;
  end: Date;
  type: "summary" | "target" | "experiment";
  open: boolean;
}

export interface PlacedMarker {
  id: string;
  kind: MarkerKind;
  x: number;
  y: number;
  rowKey: string;
  clusterId: string;
}

export const PROOF_ROW_HEIGHT = 36;

export const PROOF_SCALE: TimeScale = {
  startMs: Date.parse("2026-01-01T00:00:00.000Z"),
  endMs: Date.parse("2026-04-01T00:00:00.000Z"),
  widthPx: 180,
};

export function proofBars(): SpikeBar[] {
  return [
    {
      key: "env-1",
      parentKey: null,
      kind: "envelope",
      name: "Brand",
      start: "2026-01-01",
      end: "2026-03-31",
      markers: [
        { id: "m-approval", kind: "approval", at: "2026-02-01" },
        { id: "m-comment", kind: "comment", at: "2026-02-02" },
        { id: "m-closure", kind: "closure", at: "2026-03-01" },
      ],
    },
    {
      key: "tgt-budget",
      parentKey: "env-1",
      kind: "target",
      metric: "budget",
      name: "Budget",
      start: "2026-01-15",
      end: "2026-02-15",
      markers: [],
    },
    {
      key: "tgt-cpa",
      parentKey: "env-1",
      kind: "target",
      metric: "cpa",
      name: "CPA",
      start: "2026-01-15",
      end: "2026-02-15",
      markers: [],
    },
  ];
}

export function visibleLaneRows(bars: readonly SpikeBar[]): LaneRow[] {
  const visible = bars.filter((bar) => bar.kind !== "target" || bar.metric === "budget");
  return visible.map((bar, lane) => ({
    key: bar.key,
    parentKey: bar.parentKey,
    kind: bar.kind,
    lane,
  }));
}

export function toSvarTasks(bars: readonly SpikeBar[]): SvarTask[] {
  return bars.map((bar) => ({
    id: bar.key,
    parent: bar.parentKey ?? 0,
    text: bar.name,
    start: new Date(`${bar.start}T00:00:00.000Z`),
    end: new Date(`${bar.end}T00:00:00.000Z`),
    type: bar.kind === "envelope" ? "summary" : bar.kind,
    open: bar.kind === "envelope" || (bar.kind === "target" && bar.metric === "budget"),
  }));
}

export function markerX(scale: TimeScale, at: string): number {
  const span = scale.endMs - scale.startMs;
  if (span <= 0) {
    throw new Error("timeline scale has no span");
  }
  const instant = Date.parse(`${at}T00:00:00.000Z`);
  return ((instant - scale.startMs) / span) * scale.widthPx;
}

export function markerOverlay(bars: readonly SpikeBar[], scale: TimeScale, rowHeight: number): PlacedMarker[] {
  const lanes = new Map(visibleLaneRows(bars).map((row) => [row.key, row.lane]));
  const placed: PlacedMarker[] = [];
  for (const bar of bars) {
    const lane = lanes.get(bar.key);
    if (lane === undefined || bar.markers.length === 0) {
      continue;
    }
    const rowMarkers = bar.markers
      .map((marker) => ({
        marker,
        x: markerX(scale, marker.at),
      }))
      .sort((left, right) => left.x - right.x);
    let clusterStart = 0;
    let previousX = Number.NEGATIVE_INFINITY;
    rowMarkers.forEach((entry, index) => {
      if (index > 0 && entry.x - previousX >= 6) {
        clusterStart = index;
      }
      previousX = entry.x;
      placed.push({
        id: entry.marker.id,
        kind: entry.marker.kind,
        x: entry.x,
        y: lane * rowHeight,
        rowKey: bar.key,
        clusterId: `${bar.key}:${clusterStart}`,
      });
    });
  }
  return placed;
}
