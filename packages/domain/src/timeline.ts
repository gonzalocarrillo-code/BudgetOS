import { z } from "zod";

/**
 * The Gantt timeline (spec §23, plan §4.11): GET /workspaces/:ws/timeline. Not the decision
 * timeline of one envelope (spec §9.4, `GET /envelopes/:id/timeline`).
 *
 * Target bars carry `value`, `comparator`, `inheritedFrom` and `effective` on top of the spec's
 * TimelineBar (ADR-032): the dates on which that target is the effective one for its metric.
 */

const IsoDate = z.string().date();
export const TimelineZoom = z.enum(["week", "month", "quarter", "fy"]);
export type TimelineZoom = z.infer<typeof TimelineZoom>;

export const TimelineMarker = z.object({
  kind: z.enum(["approval", "alert", "closure", "comment", "version"]),
  at: IsoDate,
  id: z.string(),
  severity: z.string().optional(),
});
export type TimelineMarker = z.infer<typeof TimelineMarker>;

export const TimelineBar = z.object({
  key: z.string(),
  parentKey: z.string().nullable(),
  level: z.number().int(),
  kind: z.enum(["group", "envelope", "target", "experiment"]),
  name: z.string(),
  path: z.array(z.string()),
  start: IsoDate,
  end: IsoDate,
  envelopeId: z.string().uuid().optional(),
  targetId: z.string().uuid().optional(),
  experimentId: z.string().uuid().optional(),
  metric: z.string().optional(), // targets: 'budget' | 'cpa' | ...
  budget: z.string().optional(), // Decimal strings, reporting currency
  actual: z.string().optional(),
  projected: z.string().optional(),
  spendPct: z.number().min(0).max(2).optional(),
  projectedPct: z.number().optional(),
  paceIndex: z.number().optional(),
  paceState: z.enum(["under", "on", "over", "critical", "none"]).default("none"),
  status: z.string().optional(),
  hasChildren: z.boolean().default(false),
  expanded: z.boolean().default(false),
  lane: z.number().int().default(0), // stacked lane index for overlapping targets under one envelope
  markers: z.array(TimelineMarker).default([]),
  /** Targets: the current value as of `asOf` (decimal string) and how actuals compare to it. */
  value: z.string().optional(),
  comparator: z.string().optional(),
  /** Targets set on an ancestor envelope (a cap) that this envelope inherits. */
  inheritedFrom: z.string().uuid().optional(),
  /** Targets: the date ranges on which this target is the effective one for its metric. */
  effective: z.array(z.object({ start: IsoDate, end: IsoDate })).optional(),
});
export type TimelineBar = z.infer<typeof TimelineBar>;

export const TimelinePeriod = z.object({ id: z.string(), kind: z.enum(["fy", "quarter", "month", "week"]), start: IsoDate, end: IsoDate, label: z.string() });
export type TimelinePeriod = z.infer<typeof TimelinePeriod>;

export const TimelineResponse = z.object({
  bars: z.array(TimelineBar),
  /** The dimension key of each group level (level 0 first), for labelling groups with no value. */
  levels: z.array(z.string()).default([]),
  nextCursor: z.string().nullable(),
  calendar: z.object({
    fiscalYearStartMonth: z.number().int().min(1).max(12),
    periods: z.array(TimelinePeriod),
    keyDates: z.array(z.object({ at: IsoDate, label: z.string(), kind: z.enum(["holiday", "client", "closure"]) })),
  }),
  dataVersion: z.string(),
  dataAsOf: z.string().datetime(),
  asOf: z.string().datetime().optional(),
});
export type TimelineResponse = z.infer<typeof TimelineResponse>;

/**
 * GET /workspaces/:ws/timeline query string. `filter` is the FilterGroup as lz-string (the URL
 * encoding of spec §18.3) or as JSON. `groupBy` is comma-separated; without it the hierarchy
 * template's path is the grouping. The range is `from`/`to`, else `period` (a preset name or a
 * PeriodSpec as JSON, as on /pacing, resolved on the workspace's fiscal calendar), else the current
 * fiscal year.
 */
export const TimelineQuery = z
  .object({
    filter: z.string().max(20_000).optional(),
    groupBy: z.string().max(1000).optional(),
    templateId: z.string().uuid().optional(),
    /** Budget structure (ADR-050): every live budget nested by its parent links, not grouped by granularities. */
    structure: z.enum(["true", "false"]).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    period: z.string().max(2000).optional(),
    asOf: z.string().datetime().optional(),
    zoom: TimelineZoom.default("month"),
    cursor: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
    /** HF-1: "Show demo data" in the Explorer carries through to the Gantt (T-5's exclusion is default-on, not forced). */
    includeDemo: z.enum(["true", "false"]).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from is after to", path: ["to"] });
export type TimelineQuery = z.infer<typeof TimelineQuery>;

// ---------------------------------------------------------------------------------------------
// Pure helpers shared by the API (building the response) and the web (tooltips, tests).

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Fiscal periods overlapping [from, to]: FY, quarter and month, plus ISO weeks when zoomed to
 * weeks. Ids are the planner's fiscal keys (`FY2026`, `2026-Q1`, `2026-01`; a fiscal year is named
 * by the calendar year it starts in, as `resolvePeriod` reads them); weeks are `2026-W40`.
 */
export function fiscalPeriods(from: string, to: string, fiscalYearStartMonth: number, zoom: TimelineZoom): TimelinePeriod[] {
  const lo = ms(from),
    hi = ms(to);
  const out: TimelinePeriod[] = [];
  const fy0 = new Date(lo).getUTCFullYear() - (new Date(lo).getUTCMonth() + 1 < fiscalYearStartMonth ? 1 : 0);
  for (let fy = fy0; utc(fy, fiscalYearStartMonth - 1, 1) <= hi; fy++) {
    const s = utc(fy, fiscalYearStartMonth - 1, 1);
    out.push({ id: `FY${fy}`, kind: "fy", start: iso(s), end: iso(utc(fy + 1, fiscalYearStartMonth - 1, 1) - DAY), label: `FY${fy}` });
    for (let q = 0; q < 4; q++) {
      const qs = utc(fy, fiscalYearStartMonth - 1 + q * 3, 1),
        qe = utc(fy, fiscalYearStartMonth - 1 + q * 3 + 3, 1) - DAY;
      if (qe < lo || qs > hi) continue;
      out.push({ id: `${fy}-Q${q + 1}`, kind: "quarter", start: iso(qs), end: iso(qe), label: `Q${q + 1} FY${fy}` });
      for (let m = 0; m < 3; m++) {
        const d = new Date(utc(fy, fiscalYearStartMonth - 1 + q * 3 + m, 1));
        const me = utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - DAY;
        if (me < lo || d.getTime() > hi) continue;
        out.push({ id: iso(d.getTime()).slice(0, 7), kind: "month", start: iso(d.getTime()), end: iso(me), label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
      }
    }
  }
  const keep = out.filter((p) => ms(p.end) >= lo && ms(p.start) <= hi);
  if (zoom !== "week") return keep;
  // ISO weeks (Monday first) that overlap the range.
  const monday = lo - ((new Date(lo).getUTCDay() + 6) % 7) * DAY;
  for (let w = monday; w <= hi; w += 7 * DAY) {
    const thursday = new Date(w + 3 * DAY);
    const year = thursday.getUTCFullYear();
    const week = Math.floor((thursday.getTime() - utc(year, 0, 1)) / DAY / 7) + 1;
    keep.push({ id: `${year}-W${String(week).padStart(2, "0")}`, kind: "week", start: iso(w), end: iso(w + 6 * DAY), label: `W${week}` });
  }
  return keep;
}

/** A target as the timeline stacks it: its dates and how specific it is (0 = own, n = n levels up). */
export interface LaneTarget {
  id: string;
  metric: string;
  start: string;
  end: string;
  depth: number;
}

/**
 * Stacked lane per target under one envelope: overlapping targets of the same metric get
 * different lanes (greedy interval colouring, earliest start first).
 */
export function stackLanes(targets: readonly LaneTarget[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const byMetric = new Map<string, LaneTarget[]>();
  for (const t of targets) byMetric.set(t.metric, [...(byMetric.get(t.metric) ?? []), t]);
  for (const list of byMetric.values()) {
    const ends: number[] = []; // last end per lane
    for (const t of [...list].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id))) {
      let lane = ends.findIndex((e) => e < ms(t.start));
      if (lane === -1) lane = ends.length;
      ends[lane] = ms(t.end);
      lanes.set(t.id, lane);
    }
  }
  return lanes;
}

/**
 * The most specific target of one metric at a date (plan §4.11): the envelope's own target over an
 * inherited one (effective_target() walks up parents), then the shortest date range, then the
 * latest start. An annual CPA target with a Q4 override: the override in Q4, the annual elsewhere.
 */
export function effectiveTargetAt<T extends LaneTarget>(targets: readonly T[], metric: string, date: string): T | null {
  let best: T | null = null;
  for (const t of targets) {
    if (t.metric !== metric || t.start > date || t.end < date) continue;
    if (best === null || moreSpecific(t, best)) best = t;
  }
  return best;
}

function moreSpecific(a: LaneTarget, b: LaneTarget): boolean {
  if (a.depth !== b.depth) return a.depth < b.depth;
  const sa = ms(a.end) - ms(a.start),
    sb = ms(b.end) - ms(b.start);
  if (sa !== sb) return sa < sb;
  if (a.start !== b.start) return a.start > b.start;
  return a.id < b.id;
}

/** Per target, the date ranges on which it is the effective one (see `effectiveTargetAt`). */
export function effectiveSegments(targets: readonly LaneTarget[]): Map<string, Array<{ start: string; end: string }>> {
  const out = new Map<string, Array<{ start: string; end: string }>>(targets.map((t) => [t.id, []]));
  const byMetric = new Map<string, LaneTarget[]>();
  for (const t of targets) byMetric.set(t.metric, [...(byMetric.get(t.metric) ?? []), t]);
  for (const [metric, list] of byMetric) {
    // Elementary intervals between every start and every day after an end.
    const cuts = [...new Set(list.flatMap((t) => [ms(t.start), ms(t.end) + DAY]))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const s = cuts[i] as number,
        e = (cuts[i + 1] as number) - DAY;
      const winner = effectiveTargetAt(list, metric, iso(s));
      if (!winner) continue;
      const segs = out.get(winner.id) as Array<{ start: string; end: string }>;
      const last = segs.at(-1);
      if (last && ms(last.end) + DAY === s) last.end = iso(e);
      else segs.push({ start: iso(s), end: iso(e) });
    }
  }
  return out;
}

/** Pace state of a bar from its pace index (the pacing view's bands, spec §11). */
export function paceStateOf(paceIndex: number | null | undefined): TimelineBar["paceState"] {
  if (paceIndex === null || paceIndex === undefined || !Number.isFinite(paceIndex)) return "none";
  if (paceIndex > 1.25) return "critical";
  if (paceIndex > 1.1) return "over";
  if (paceIndex < 0.9) return "under";
  return "on";
}
