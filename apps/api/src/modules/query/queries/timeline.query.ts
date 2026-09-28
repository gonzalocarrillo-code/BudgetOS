import {
  DomainError,
  FilterGroup,
  LIVE_LEAVES,
  TimelineQuery,
  effectiveSegments,
  fiscalPeriods,
  paceStateOf,
  resolvePeriod,
  stackLanes,
  type FilterGroupT,
  type LaneTarget,
  type TimelineBar,
  type TimelineResponse,
} from "@budget/domain";
import { ganttKeyDates, ganttMarkers, ganttTargets, plannerOptions, withTenant, type Tx, fiscalCalendar } from "@budget/db";
import { compileQuery, pageOf, sanitize, type CompileOptions } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import LZString from "lz-string";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { parsePeriodParam } from "../../pacing/queries.js";
import { scopedQuery } from "./run-query.js";

/**
 * GET /workspaces/:ws/timeline (spec §23.1, T-037): the Gantt of envelopes and their target lanes
 * on the fiscal calendar, grouped by `groupBy` or the hierarchy template's path. Built on the
 * planner like /query: the same FilterGroup, the caller's read scope ANDed in, live leaves only
 * (ADR-016), `asOf` for budgets, targets and markers. Group bars (every level) come with the first
 * page; envelope bars are keyset-paged by name, each followed by its target lanes.
 */

type Row = Record<string, unknown>;
const NONE = "∅";
const MEASURES = ["budget", "actual", "projected", "pace_index"] as const;
const PAGE = 1000;

const money = (v: unknown) => (v === null || v === undefined ? undefined : new Decimal(String(v)).toFixed(2));
const ratio = (num: unknown, den: unknown): number | undefined => {
  if (num === null || num === undefined || den === null || den === undefined) return undefined;
  const d = new Decimal(String(den));
  return d.lte(0) ? undefined : new Decimal(String(num)).div(d).toDecimalPlaces(4).toNumber();
};
const num = (v: unknown) => (v === null || v === undefined ? undefined : new Decimal(String(v)).toDecimalPlaces(4).toNumber());
const compact = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The `filter` query parameter: lz-string (the web's URL encoding, spec §18.3) or plain JSON. */
export function parseFilterParam(raw: string | undefined): FilterGroupT | undefined {
  if (raw === undefined || raw === "") return undefined;
  const json = raw.trimStart().startsWith("{") ? raw : LZString.decompressFromEncodedURIComponent(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "");
  } catch {
    throw new DomainError("VALIDATION", "filter must be a FilterGroup as lz-string or JSON");
  }
  return parseInput(FilterGroup, parsed);
}

function measuresOf(r: Row) {
  const pace = num(r["pace_index"]);
  const spend = ratio(r["actual"], r["budget"]);
  return compact({
    budget: money(r["budget"]),
    actual: money(r["actual"]),
    projected: money(r["projected"]),
    spendPct: spend === undefined ? undefined : Math.min(2, Math.max(0, spend)),
    projectedPct: ratio(r["projected"], r["budget"]),
    paceIndex: pace,
    paceState: paceStateOf(pace),
  });
}

async function allPages(tx: Tx, q: Parameters<typeof compileQuery>[0], period: { start: string; end: string }, today: string, opts: CompileOptions): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  for (;;) {
    const c = compileQuery({ ...q, limit: PAGE, ...(cursor ? { cursor } : {}) }, period, today, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), PAGE);
    out.push(...page.rows);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

export async function timelineQuery(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()): Promise<TimelineResponse> {
  const q = parseInput(TimelineQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const userFilter = parseFilterParam(q.filter);
  const asOf = q.asOf ? new Date(q.asOf) : now;
  const today = now.toISOString().slice(0, 10);

  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true, settings: true } });
    const fy = ws.fiscalYearStartMonth;
    const spec = resolvePeriod(parsePeriodParam(q.period), today, fy, await fiscalCalendar(tx, workspaceId));
    const period = { start: q.from ?? spec.start, end: q.to ?? spec.end };
    if (period.start > period.end) throw new DomainError("VALIDATION", "from is after to");

    const structure = q.structure === "true";
    const groupBy = structure ? [] : q.groupBy ? q.groupBy.split(",").map((k) => k.trim()).filter(Boolean) : null;
    const template = groupBy
      ? null
      : await tx.hierarchyTemplate.findFirst({ where: { workspaceId, ...(q.templateId ? { id: q.templateId } : {}) }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, path: true } });
    if (q.templateId && !template) throw new DomainError("NOT_FOUND", "Hierarchy template not found");
    const levels = groupBy ?? template?.path ?? [];
    if (levels.length > 8) throw new DomainError("VALIDATION", "At most 8 grouping levels");

    // Live leaves, the caller's filter and their read scope (the same cut as /query).
    // Structure (ADR-050): every live budget, parents included, each with its subtree's spend.
    const cut = structure ? [LIVE_LEAVES[1] as (typeof LIVE_LEAVES)[number]] : LIVE_LEAVES;
    const filter: FilterGroupT = { logic: "and", children: [...cut, ...(userFilter && userFilter.children.length ? [userFilter] : [])] };
    const base = scopedQuery(auth, { workspaceId, filter, period: { kind: "range", ...period }, measures: [...MEASURES], ...(q.asOf ? { asOf: q.asOf } : {}), ...(structure ? { subtree: true } : {}) });
    const opts: CompileOptions = { ...(await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId }, [], period)), groupDates: true };

    const bars: TimelineBar[] = [];
    if (q.cursor === undefined) {
      for (let depth = 1; depth <= levels.length; depth++) {
        const keys = levels.slice(0, depth);
        for (const r of await allPages(tx, { ...base, groupBy: keys, sort: [] }, period, today, opts)) {
          const segments = keys.map((k) => (r[`dim_${sanitize(k)}`] === null || r[`dim_${sanitize(k)}`] === undefined ? NONE : String(r[`dim_${sanitize(k)}`])));
          const last = keys.length - 1;
          const label = r[`lbl_${sanitize(keys[last] as string)}`];
          bars.push({
            key: segments.join("/"),
            parentKey: depth === 1 ? null : segments.slice(0, -1).join("/"),
            level: depth - 1,
            kind: "group",
            name: segments[last] === NONE ? NONE : String(label ?? segments[last]),
            path: segments,
            start: String(r["start_date"]),
            end: String(r["end_date"]),
            ...measuresOf(r),
            hasChildren: true,
            expanded: true,
            lane: 0,
            markers: [],
          });
        }
      }
    }

    // One page of envelopes (the leaves), by name. Structure: all of them, so every parent is there.
    const page = structure
      ? { rows: await allPages(tx, { ...base, groupBy: [], sort: [{ key: "name", dir: "asc" }] }, period, today, opts), nextCursor: null }
      : await (async () => {
          const c = compileQuery({ ...base, groupBy: [], sort: [{ key: "name", dir: "asc" }], limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) }, period, today, opts);
          return pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
        })();
    // Structure: a budget sits under its parent when the parent is shown, else at the top.
    const shown = new Set(page.rows.map((r) => String(r["envelope_id"])));
    const parentOf = (r: Row) => (structure && r["parent_id"] && shown.has(String(r["parent_id"])) ? String(r["parent_id"]) : null);
    const byId = new Map(page.rows.map((r) => [String(r["envelope_id"]), r]));
    const depthOf = (r: Row): number => {
      let d = 0;
      for (let p = parentOf(r); p !== null && d < 50; d++) p = parentOf(byId.get(p) as Row);
      return d;
    };
    if (structure) {
      // Parents before their children, siblings by name: the Gantt reads the rows as a tree.
      const kids = new Map<string | null, Row[]>();
      for (const r of page.rows) kids.set(parentOf(r), [...(kids.get(parentOf(r)) ?? []), r]);
      const ordered: Row[] = [];
      const walk = (p: string | null) => {
        for (const r of kids.get(p) ?? []) {
          ordered.push(r);
          walk(String(r["envelope_id"]));
        }
      };
      walk(null);
      page.rows = ordered;
    }
    const ids = page.rows.map((r) => String(r["envelope_id"]));
    const dates = new Map((await tx.envelope.findMany({ where: { id: { in: ids } }, select: { id: true, startDate: true, endDate: true } })).map((e) => [e.id, e]));
    const targets = await ganttTargets(tx, workspaceId, ids, period.start, period.end, asOf);
    const markers = await ganttMarkers(tx, ids, period.start, period.end, asOf);
    // T-038: experiments linked to these envelopes whose window overlaps the range, as they existed at asOf.
    const experimentLinks = await tx.experimentEnvelope.findMany({
      where: { envelopeId: { in: ids }, experiment: { startDate: { lte: new Date(period.end) }, endDate: { gte: new Date(period.start) }, createdAt: { lte: asOf } } },
      include: { experiment: { select: { id: true, name: true, status: true, startDate: true, endDate: true } } },
      orderBy: [{ envelopeId: "asc" }, { experimentId: "asc" }],
    });
    const experimentsOf = new Map<string, typeof experimentLinks>();
    for (const l of experimentLinks) experimentsOf.set(l.envelopeId, [...(experimentsOf.get(l.envelopeId) ?? []), l]);
    const targetsOf = new Map<string, typeof targets>();
    for (const t of targets) targetsOf.set(t.envelopeId, [...(targetsOf.get(t.envelopeId) ?? []), t]);
    const markersOf = new Map<string, TimelineBar["markers"]>();
    for (const m of markers) markersOf.set(m.envelopeId, [...(markersOf.get(m.envelopeId) ?? []), { kind: m.kind, at: m.at, id: m.id, ...(m.severity ? { severity: m.severity } : {}) }]);

    for (const r of page.rows) {
      const id = String(r["envelope_id"]);
      const dv = (r["dimension_values"] ?? {}) as Record<string, unknown>;
      const segments = levels.map((k) => (dv[k] === null || dv[k] === undefined || dv[k] === "" ? NONE : String(dv[k])));
      const d = dates.get(id);
      const own = targetsOf.get(id) ?? [];
      const iso = (x: Date | undefined) => (x ? x.toISOString().slice(0, 10) : period.start);
      const level = structure ? depthOf(r) : levels.length;
      bars.push({
        key: id,
        parentKey: structure ? parentOf(r) : levels.length ? segments.join("/") : null,
        level,
        kind: "envelope",
        name: String(r["name"]),
        path: [...segments, String(r["name"])],
        start: iso(d?.startDate),
        end: d ? iso(d.endDate) : period.end,
        envelopeId: id,
        ...measuresOf(r),
        status: String(r["status"]),
        hasChildren: own.length > 0 || experimentsOf.has(id) || Number(r["child_count"] ?? 0) > 0,
        expanded: false,
        lane: 0,
        markers: markersOf.get(id) ?? [],
      });
      // Target lanes: stacked where they overlap; `effective` is where each one applies.
      const lanesIn: LaneTarget[] = own.map((t) => ({ id: t.targetId, metric: t.metricKey, start: t.startDate, end: t.endDate, depth: t.depth }));
      const lanes = stackLanes(lanesIn);
      const effective = effectiveSegments(lanesIn);
      for (const t of own) {
        bars.push({
          key: `${id}:${t.targetId}`,
          parentKey: id,
          level: level + 1,
          kind: "target",
          name: t.metricKey,
          path: [...segments, String(r["name"]), t.metricKey],
          start: t.startDate,
          end: t.endDate,
          envelopeId: id,
          targetId: t.targetId,
          metric: t.metricKey,
          value: t.value,
          comparator: t.comparator,
          ...(t.depth > 0 ? { inheritedFrom: t.ownerId } : {}),
          effective: effective.get(t.targetId) ?? [],
          paceState: "none",
          hasChildren: false,
          expanded: false,
          lane: lanes.get(t.targetId) ?? 0,
          markers: [],
        });
      }
      // Experiment lanes (T-038): the evaluation window, hatched; status and role in `status`.
      for (const l of experimentsOf.get(id) ?? []) {
        const x = l.experiment;
        bars.push({
          key: `${id}:x:${x.id}`,
          parentKey: id,
          level: level + 1,
          kind: "experiment",
          name: x.name,
          path: [...segments, String(r["name"]), x.name],
          start: x.startDate.toISOString().slice(0, 10),
          end: x.endDate.toISOString().slice(0, 10),
          envelopeId: id,
          experimentId: x.id,
          status: `${x.status} · ${l.role}`,
          paceState: "none",
          hasChildren: false,
          expanded: false,
          lane: 0,
          markers: [],
        });
      }
    }

    return {
      levels,
      bars,
      nextCursor: page.nextCursor,
      calendar: {
        fiscalYearStartMonth: fy,
        periods: fiscalPeriods(period.start, period.end, fy, q.zoom),
        keyDates: await ganttKeyDates(tx, workspaceId, period.start, period.end, asOf),
      },
      dataVersion: String((ws.settings as { dataVersion?: number } | null)?.dataVersion ?? 0),
      dataAsOf: now.toISOString(),
      ...(q.asOf ? { asOf: q.asOf } : {}),
    };
  });
}
