import type { TimelineBar } from "@budget/domain";
import { toLocal } from "./fiscal-scales.js";

/**
 * TimelineBar → SVAR task (spec §23.2). Target and experiment rows are children of their envelope,
 * collapsed by default except `budget`-metric targets: a collapsed envelope passes only its budget-target rows and
 * is `lazy` when it has others, so SVAR draws the expand arrow and asks for them (ADR-003: `open`
 * on a task with no children throws, so `open` is set only where children are passed).
 */

export interface SvarTask {
  id: string;
  parent: string | number;
  text: string;
  start: Date;
  end: Date;
  type: TimelineBar["kind"];
  progress: number;
  open?: boolean;
  lazy?: boolean;
  bar: TimelineBar;
}

const DAY = 86_400_000;

export function visibleBars(bars: readonly TimelineBar[], openEnvelopes: ReadonlySet<string>): TimelineBar[] {
  const keys = new Set(bars.map((b) => b.key));
  return bars.filter((b) => {
    if (b.parentKey !== null && !keys.has(b.parentKey)) return false; // parent on another page or filtered out
    if (b.kind === "experiment") return openEnvelopes.has(b.parentKey ?? "");
    return b.kind !== "target" || b.metric === "budget" || openEnvelopes.has(b.parentKey ?? "");
  });
}

export function toSvarTasks(bars: readonly TimelineBar[], openEnvelopes: ReadonlySet<string>): SvarTask[] {
  const visible = visibleBars(bars, openEnvelopes);
  const withChildren = new Set(visible.map((b) => b.parentKey).filter((k): k is string => k !== null));
  return visible.map((b) => {
    const has = withChildren.has(b.key);
    const task: SvarTask = {
      id: b.key,
      parent: b.parentKey ?? 0,
      text: b.name,
      start: toLocal(b.start),
      // SVAR's end is exclusive: a bar through Dec 31 ends at Jan 1, 00:00.
      end: new Date(toLocal(b.end).getTime() + DAY),
      type: b.kind,
      progress: Math.round(Math.min(1, b.spendPct ?? 0) * 100),
      bar: b,
    };
    if (has) task.open = b.kind === "group" ? b.expanded : true;
    else if (b.hasChildren && b.kind === "envelope") task.lazy = true;
    return task;
  });
}
