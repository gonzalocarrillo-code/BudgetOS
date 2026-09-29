import type { TimelineBar, TimelineMarker, TimelineResponse, TimelineZoom } from "@budget/domain";
import { Gantt, Willow, defaultTaskTypes, type IApi, type ITask } from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/all.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cellWidthFor, chartRange, fiscalScales, fromLocal, toLocal } from "./fiscal-scales.js";
import { clusterKind, dateAtX, placeMarkers, type MarkerCluster } from "./overlay.js";
import { toSvarTasks } from "./tasks.js";
import "./timeline.css";

/**
 * BudgetTimeline (spec §23.2) on the SVAR React Gantt MIT core: fiscal scales, bar templates
 * (spend fill, projected-close tick, pace colour; thin target bars with their effective ranges),
 * our marker overlay (SVAR's markers are PRO), a today line and the as-of scrubber. With
 * `onReschedule` (plan epic 2.5, ADR-061) a budget's bar can be dragged or its ends resized: the new
 * dates go to the caller, which confirms them (and the approval they need) or reverts the bar.
 * Nothing else SVAR could edit is allowed: no adding, deleting, linking, progress or cell edits.
 * The caller does the fetching; this renders `data`.
 */

export type TimelineOpen = { kind: "bar"; bar: TimelineBar } | { kind: "marker"; bar: TimelineBar; markers: TimelineMarker[] };

export interface BudgetTimelineLabels {
  name: string;
  budget: string;
  spent: string;
  today: string;
  asOf: string;
  inherited: string;
  none: string;
  /** The label of a group with no value at `level` (0 = first); falls back to `none`. */
  noneAt?: (level: number) => string;
  marker: Record<TimelineMarker["kind"], string>;
}

export interface BudgetTimelineProps {
  data: TimelineResponse;
  zoom: TimelineZoom;
  /** The as-of instant shown (ISO datetime), or undefined for now. */
  asOf?: string | undefined;
  /** yyyy-MM-dd: where the today line is drawn. */
  today: string;
  readOnly?: boolean;
  labels: BudgetTimelineLabels;
  formatMoney: (amount: string) => string;
  metricLabel?: (metric: string) => string;
  onOpen: (target: TimelineOpen) => void;
  onToggle?: (key: string, open: boolean) => void;
  /** Called when the scrubber is released: end of that day (UTC), or undefined when dropped on today or later. */
  onAsOfChange: (asOf: string | undefined) => void;
  /** Which bars can be dragged or resized (with `readOnly` false). */
  canReschedule?: (bar: TimelineBar) => boolean;
  /**
   * A bar was dropped with new dates (inclusive, yyyy-MM-dd). It stays where it was dropped until the
   * caller calls `revert` (cancelled) or passes new `data` (the change applied).
   */
  onReschedule?: (bar: TimelineBar, dates: { start: string; end: string }, revert: () => void) => void;
}

const ROW = 36;
/** SVAR actions that would edit anything but a budget bar's dates: always refused. */
const REFUSED = ["add-task", "delete-task", "copy-task", "move-task", "indent-task", "add-link", "update-link", "delete-link", "show-editor"] as const;
const REVERT = "budget-os-revert";
const TYPES = [...defaultTaskTypes, { id: "group", label: "Group" }, { id: "envelope", label: "Envelope" }, { id: "target", label: "Target" }, { id: "experiment", label: "Experiment" }];

type Ctx = { labels: BudgetTimelineLabels; formatMoney: (a: string) => string; metricLabel: (m: string) => string; movable: (bar: TimelineBar) => boolean };
let ctx: Ctx = { labels: {} as BudgetTimelineLabels, formatMoney: (a) => a, metricLabel: (m) => m, movable: () => false };

const pct = (n: number | undefined) => `${Math.round(Math.max(0, n ?? 0) * 100)}%`;
const comparatorSign: Record<string, string> = { lte: "≤", gte: "≥", eq: "=", between: "↔" };

/** The bar drawn inside SVAR's bar box (`taskTemplate`). */
function BarTemplate({ data }: { data: ITask }): ReactElement {
  const bar = (data as { bar?: TimelineBar }).bar;
  if (!bar) return <span />;
  if (bar.kind === "target") {
    const span = Math.max(1, toLocal(bar.end).getTime() - toLocal(bar.start).getTime() + 86_400_000);
    const at = (d: string) => ((toLocal(d).getTime() - toLocal(bar.start).getTime()) / span) * 100;
    return (
      <div className="bt-target" data-bar-key={bar.key} data-lane={bar.lane} data-inherited={bar.inheritedFrom ? "true" : "false"}>
        {(bar.effective ?? []).map((s) => (
          <span key={s.start} className="bt-target-effective" style={{ left: `${at(s.start)}%`, width: `${at(s.end) - at(s.start) + (86_400_000 / span) * 100}%` }} data-effective={`${s.start}..${s.end}`} />
        ))}
        <span className="bt-bar-label">
          {ctx.metricLabel(bar.metric ?? "")} {comparatorSign[bar.comparator ?? ""] ?? ""} {bar.value ? Number(bar.value).toString() : ""}
          {bar.inheritedFrom ? <em> · {ctx.labels.inherited}</em> : null}
        </span>
      </div>
    );
  }
  const style: CSSProperties = { width: pct(Math.min(1, bar.spendPct ?? 0)) };
  return (
    <div className={`bt-bar bt-${bar.kind}`} data-bar-key={bar.key} data-pace={bar.paceState} data-kind={bar.kind} data-movable={ctx.movable(bar) ? "true" : "false"}>
      <span className="bt-fill" style={style} />
      {bar.projectedPct !== undefined && bar.projectedPct > 0 ? <span className="bt-projected" style={{ left: `min(${pct(bar.projectedPct)}, calc(100% - 2px))` }} title={pct(bar.projectedPct)} /> : null}
      <span className="bt-bar-label">{bar.kind === "group" && bar.name === "∅" ? (ctx.labels.noneAt?.(bar.level) ?? ctx.labels.none) : bar.kind === "experiment" && bar.status ? `${bar.name} · ${bar.status.toLowerCase()}` : bar.name}</span>
    </div>
  );
}

function NameCell({ row }: { row: ITask }): ReactElement {
  const bar = (row as { bar?: TimelineBar }).bar;
  if (!bar) return <span />;
  const text =
    bar.kind === "target"
      ? `${ctx.metricLabel(bar.metric ?? "")} ${comparatorSign[bar.comparator ?? ""] ?? ""} ${bar.value ? Number(bar.value).toString() : ""}${bar.inheritedFrom ? ` · ${ctx.labels.inherited}` : ""}`
      : bar.name === "∅"
        ? (ctx.labels.noneAt?.(bar.level) ?? ctx.labels.none)
        : bar.name;
  return (
    <span className={`bt-cell-name bt-cell-${bar.kind}`} title={text} data-row-key={bar.key}>
      {text}
    </span>
  );
}
function BudgetCell({ row }: { row: ITask }): ReactElement {
  const bar = (row as { bar?: TimelineBar }).bar;
  return <span className="bt-cell-num">{bar?.budget ? ctx.formatMoney(bar.budget) : ""}</span>;
}
function SpentCell({ row }: { row: ITask }): ReactElement {
  const bar = (row as { bar?: TimelineBar }).bar;
  if (!bar || bar.kind === "target" || bar.spendPct === undefined) return <span />;
  return (
    <span className="bt-cell-num" data-pace={bar.paceState}>
      <i className="bt-dot" aria-hidden />
      {pct(bar.spendPct)}
    </span>
  );
}

/** What the overlay needs from SVAR's state: x of a date, and the visible rows' y. */
interface Geometry {
  width: number;
  height: number;
  xOf: (date: string) => number;
  rows: Array<{ key: string; y: number }>;
}

function readGeometry(api: IApi): Geometry | null {
  const s = api.getState();
  const scales = s._scales;
  if (!scales) return null;
  // As SVAR places a bar: $x = round(diff(start, scale start, lengthUnit) × cellWidth).
  const cellWidth = (s as { cellWidth?: number }).cellWidth ?? 0;
  const xOf = (date: string) => Math.round(scales.diff(toLocal(date), scales.start, scales.lengthUnit) * cellWidth);
  const rows = ((s._tasks ?? []) as Array<{ id: string | number; $y?: number }>).map((t) => ({ key: String(t.id), y: t.$y ?? 0 }));
  return { width: scales.width, height: Math.max(rows.length * ROW, (s as { _chartHeight?: number })._chartHeight ?? 0), xOf, rows };
}

export function BudgetTimeline({ data, zoom, asOf, today, readOnly = true, labels, formatMoney, metricLabel, onOpen, onToggle, onAsOfChange, canReschedule, onReschedule }: BudgetTimelineProps): ReactElement {
  ctx = { labels, formatMoney, metricLabel: metricLabel ?? ((m) => m.toUpperCase()), movable: (bar) => !readOnly && onReschedule !== undefined && (canReschedule?.(bar) ?? false) };
  const [openEnvelopes, setOpenEnvelopes] = useState<Set<string>>(() => new Set());
  const [api, setApi] = useState<IApi | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [area, setArea] = useState<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const byKey = useMemo(() => new Map(data.bars.map((b) => [b.key, b])), [data.bars]);
  const tasks = useMemo(() => toSvarTasks(data.bars, openEnvelopes), [data.bars, openEnvelopes]);
  const scales = useMemo(() => fiscalScales(zoom, data.calendar), [zoom, data.calendar]);
  const range = useMemo(() => chartRange(data.calendar), [data.calendar]);
  const callbacks = useRef({ onOpen, onToggle, byKey, canReschedule, onReschedule, editable: !readOnly });
  callbacks.current = { onOpen, onToggle, byKey, canReschedule, onReschedule, editable: !readOnly };

  const columns = useMemo(
    () => [
      { id: "text", header: labels.name, flexgrow: 1, cell: NameCell },
      { id: "budget", header: labels.budget, width: 130, align: "right" as const, cell: BudgetCell },
      { id: "spent", header: labels.spent, width: 76, align: "right" as const, cell: SpentCell },
    ],
    [labels.name, labels.budget, labels.spent],
  );

  const init = useCallback((a: IApi) => {
    // Lazy envelopes: their target lanes are in `data` already; opening one passes them in.
    a.intercept("request-data", ({ id }: { id: string | number }) => {
      const key = String(id);
      setOpenEnvelopes((prev) => new Set(prev).add(key));
      callbacks.current.onToggle?.(key, true);
      return false;
    });
    a.on("open-task", ({ id, mode }: { id: string | number; mode: boolean }) => {
      const key = String(id);
      const bar = callbacks.current.byKey.get(key);
      if (bar?.kind === "envelope" && !mode) setOpenEnvelopes((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev));
      callbacks.current.onToggle?.(key, mode);
    });
    a.on("select-task", ({ id }: { id: string | number }) => {
      const bar = callbacks.current.byKey.get(String(id));
      if (bar) callbacks.current.onOpen({ kind: "bar", bar });
    });
    for (const action of REFUSED) a.intercept(action, () => false);
    // Epic 2.5: only a budget bar the caller allows moves, and only its dates.
    const movable = (id: string | number) => {
      const c = callbacks.current;
      const bar = c.byKey.get(String(id));
      return c.editable && c.onReschedule !== undefined && bar !== undefined && (c.canReschedule?.(bar) ?? false);
    };
    a.intercept("drag-task", ({ id }: { id: string | number }) => movable(id));
    const before = new Map<string, { start: Date; end: Date }>();
    a.intercept("update-task", (ev: { id: string | number; task: Partial<ITask>; eventSource?: string }) => {
      if (ev.eventSource === REVERT) return true;
      // A drop carries start and/or end (and a diff); progress, text and anything else are refused.
      const keys = Object.keys(ev.task ?? {});
      if (keys.length === 0 || keys.some((k) => k !== "start" && k !== "end") || !movable(ev.id)) return false;
      const t = a.getTask(ev.id) as ITask | undefined;
      if (t?.start && t.end) before.set(String(ev.id), { start: t.start, end: t.end });
      return true;
    });
    a.on("update-task", (ev: { id: string | number; eventSource?: string; inProgress?: boolean }) => {
      if (ev.eventSource === REVERT || ev.inProgress) return;
      const key = String(ev.id);
      const was = before.get(key);
      before.delete(key);
      const bar = callbacks.current.byKey.get(key);
      const t = a.getTask(ev.id) as ITask | undefined;
      if (!was || !bar || !t?.start || !t.end) return;
      // SVAR's end is exclusive (see tasks.ts): the last day is the day before it.
      const dates = { start: fromLocal(t.start), end: fromLocal(new Date(t.end.getTime() - 86_400_000)) };
      const revert = () => void a.exec("update-task", { id: ev.id, task: { start: was.start, end: was.end }, eventSource: REVERT });
      if (dates.start === bar.start && dates.end === bar.end) return revert();
      callbacks.current.onReschedule?.(bar, dates, revert);
    });
    setApi(a);
  }, []);

  // SVAR's reactive state has no unsubscribe: guard with `live` and re-read the geometry per frame.
  useEffect(() => {
    if (!api) return;
    let live = true;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (live) setGeometry(readGeometry(api));
      });
    };
    const state = api.getReactiveState();
    state._tasks.subscribe(refresh);
    state._scales.subscribe(refresh);
    refresh();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [api]);

  // The overlay lives inside SVAR's scrolled chart area so it moves with the bars.
  useEffect(() => {
    let frame = 0;
    const find = () => {
      const el = root.current?.querySelector<HTMLElement>(".wx-chart .wx-area") ?? null;
      if (el) setArea((prev) => (prev === el ? prev : el));
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [api, tasks]);

  const clusters = useMemo(() => {
    if (!geometry) return [];
    const y = new Map(geometry.rows.map((r) => [r.key, r.y]));
    const rows = data.bars.filter((b) => b.markers.length > 0 && y.has(b.key)).map((b) => ({ key: b.key, y: y.get(b.key) as number, markers: b.markers }));
    return placeMarkers(rows, geometry.xOf);
  }, [geometry, data.bars]);

  return (
    <div className="bt-root" ref={root} data-readonly={readOnly} data-zoom={zoom} data-testid="budget-timeline" data-bars={tasks.length}>
      <Willow>
        <Gantt
          init={init}
          tasks={tasks}
          scales={scales}
          columns={columns}
          taskTypes={TYPES}
          cellWidth={cellWidthFor(zoom)}
          cellHeight={ROW}
          scaleHeight={30}
          autoScale={false}
          {...(range ? { start: range.start, end: range.end } : {})}
          readonly={readOnly}
          taskTemplate={BarTemplate}
        />
      </Willow>
      {area && geometry
        ? createPortal(
            <Overlay
              geometry={geometry}
              clusters={clusters}
              today={today}
              asOf={asOf}
              keyDates={data.calendar.keyDates}
              range={range ? { from: fromLocal(range.start), to: fromLocal(new Date(range.end.getTime() - 86_400_000)) } : null}
              labels={labels}
              onMarker={(c) => {
                const bar = byKey.get(c.rowKey);
                if (bar) onOpen({ kind: "marker", bar, markers: c.markers });
              }}
              onAsOfChange={onAsOfChange}
            />,
            area,
          )
        : null}
    </div>
  );
}

function Overlay({
  geometry,
  clusters,
  today,
  asOf,
  keyDates,
  range,
  labels,
  onMarker,
  onAsOfChange,
}: {
  geometry: Geometry;
  clusters: MarkerCluster[];
  today: string;
  asOf: string | undefined;
  keyDates: TimelineResponse["calendar"]["keyDates"];
  range: { from: string; to: string } | null;
  labels: BudgetTimelineLabels;
  onMarker: (c: MarkerCluster) => void;
  onAsOfChange: (asOf: string | undefined) => void;
}): ReactElement {
  const inRange = (d: string) => range === null || (d >= range.from && d <= range.to);
  const asOfDate = asOf ? asOf.slice(0, 10) : today;
  const [drag, setDrag] = useState<string | null>(null);
  const shown = drag ?? asOfDate;
  const layer = useRef<HTMLDivElement | null>(null);

  const dayAt = (clientX: number) => {
    const box = layer.current?.getBoundingClientRect();
    if (!box || !range) return shown;
    const d = dateAtX(clientX - box.left, range.from, range.to, geometry.xOf);
    return d > today ? today : d;
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(dayAt(e.clientX));
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(dayAt(e.clientX));
  };
  const commit = (day: string) => onAsOfChange(day >= today ? undefined : `${day}T23:59:59.999Z`);
  const onUp = () => {
    if (drag === null) return;
    const day = drag;
    setDrag(null);
    commit(day);
  };
  // Keyboard: ←/→ a day, with Shift a week; Home jumps to the start, End back to now.
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!range) return;
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    if (step !== undefined) {
      e.preventDefault();
      const next = shift(shown, step * (e.shiftKey ? 7 : 1));
      commit(next < range.from ? range.from : next > today ? today : next);
    } else if (e.key === "Home") {
      e.preventDefault();
      commit(range.from);
    } else if (e.key === "End") {
      e.preventDefault();
      commit(today);
    }
  };

  return (
    <div ref={layer} className="bt-overlay" style={{ width: geometry.width, height: geometry.height }} data-testid="timeline-overlay">
      {keyDates.filter((k) => inRange(k.at)).map((k) => (
        <div key={`${k.kind}-${k.at}-${k.label}`} className={`bt-keydate bt-keydate-${k.kind}`} style={{ left: geometry.xOf(k.at) }} title={`${k.label}`} data-keydate={k.at} />
      ))}
      {inRange(today) ? <div className="bt-today" style={{ left: geometry.xOf(today) }} title={labels.today} data-testid="timeline-today" data-date={today} /> : null}
      {clusters.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`bt-marker bt-marker-${clusterKind(c)}`}
          style={{ left: c.x - 5, top: c.y + ROW / 2 - 13 }}
          onClick={() => onMarker(c)}
          title={c.markers.map((m) => `${labels.marker[m.kind]} · ${m.at}`).join("\n")}
          aria-label={c.markers.map((m) => `${labels.marker[m.kind]} ${m.at}`).join(", ")}
          data-testid="timeline-marker"
          data-cluster-size={c.markers.length}
          data-kind={clusterKind(c)}
          data-row-key={c.rowKey}
        >
          {c.markers.length > 1 ? <span>{c.markers.length}</span> : null}
        </button>
      ))}
      {range && inRange(shown) ? (
        <div className={`bt-asof${asOf || drag ? " bt-asof-past" : ""}`} style={{ left: geometry.xOf(shown) }} data-testid="timeline-asof" data-date={shown}>
          <div className="bt-asof-handle" role="slider" aria-label={labels.asOf} aria-valuetext={shown} tabIndex={0} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} onKeyDown={onKey} data-testid="timeline-asof-handle">
            {labels.asOf} {shown}
          </div>
        </div>
      ) : null}
    </div>
  );
}
