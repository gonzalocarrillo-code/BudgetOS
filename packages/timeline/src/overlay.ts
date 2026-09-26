import type { TimelineMarker } from "@budget/domain";

/**
 * The marker overlay's layout (spec §23.2; SVAR's markers are PRO, so this is ours): each row's
 * markers at the Gantt's x for their date and the row's y; markers under 6 px apart on one row
 * share a cluster, drawn as one dot with a count.
 */

export interface OverlayRow {
  key: string;
  /** Top of the row's bar in chart pixels. */
  y: number;
  markers: readonly TimelineMarker[];
}

export interface MarkerCluster {
  id: string;
  rowKey: string;
  x: number;
  y: number;
  markers: TimelineMarker[];
}

export const CLUSTER_PX = 6;

export function placeMarkers(rows: readonly OverlayRow[], xOf: (date: string) => number): MarkerCluster[] {
  const out: MarkerCluster[] = [];
  for (const row of rows) {
    if (row.markers.length === 0) continue;
    const placed = row.markers.map((m) => ({ m, x: xOf(m.at) })).sort((a, b) => a.x - b.x || a.m.id.localeCompare(b.m.id));
    let current: MarkerCluster | null = null;
    let previousX = Number.NEGATIVE_INFINITY;
    for (const p of placed) {
      if (current === null || p.x - previousX >= CLUSTER_PX) {
        current = { id: `${row.key}:${p.m.id}`, rowKey: row.key, x: p.x, y: row.y, markers: [] };
        out.push(current);
      }
      current.markers.push(p.m);
      previousX = p.x;
    }
  }
  return out;
}

/** Which marker kind a cluster shows: the most important one in it. */
const ORDER: Array<TimelineMarker["kind"]> = ["alert", "approval", "closure", "version", "comment"];
export function clusterKind(c: MarkerCluster): TimelineMarker["kind"] {
  return ORDER.find((k) => c.markers.some((m) => m.kind === k)) ?? "comment";
}

/** Inverse of a monotonic x(date) over whole days in [from, to]: the day whose x is nearest `x`. */
export function dateAtX(x: number, from: string, to: string, xOf: (date: string) => number): string {
  const DAY = 86_400_000;
  let lo = Date.parse(`${from}T00:00:00Z`);
  let hi = Date.parse(`${to}T00:00:00Z`);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  while (hi - lo > DAY) {
    const mid = lo + Math.floor((hi - lo) / DAY / 2) * DAY;
    if (xOf(iso(mid)) <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xOf(iso(hi)) - x) < Math.abs(xOf(iso(lo)) - x) ? iso(hi) : iso(lo);
}
