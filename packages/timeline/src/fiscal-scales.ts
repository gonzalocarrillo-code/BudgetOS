import { registerScaleUnit, type IScaleConfig } from "@svar-ui/react-gantt";
import type { TimelineResponse, TimelineZoom } from "@budget/domain";

/**
 * Fiscal scales for SVAR (spec §23.2): FY › quarter › month › week from the workspace calendar.
 * SVAR's `year` and `quarter` units are calendar ones, so a fiscal year that does not start in
 * January (or a quarter that does not start in Jan/Apr/Jul/Oct) gets its own registered unit.
 * Labels come from `calendar.periods`, not from the calendar month.
 */

type Calendar = TimelineResponse["calendar"];

/** SVAR works in local time: a business date is local midnight. */
export const toLocal = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
export const fromLocal = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

/**
 * ISO week number for a week cell starting at `d`. SVAR's week cells start on Sunday (its locale's
 * week start): a Sunday cell is labelled by the ISO week it shares six days with.
 */
export function isoWeek(d: Date): number {
  const ref = d.getDay() === 0 ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : d;
  const thursday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 3 - ((ref.getDay() + 6) % 7));
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor(days(jan1, thursday) / 7) + 1;
}

const registered = new Set<string>();

/** First day of the fiscal year (`fy`) or quarter (`fq`) that holds `d`: the registered units' `start`. */
export function fiscalUnitStart(kind: "fy" | "fq", fyStartMonth: number, d: Date): Date {
  const months = kind === "fy" ? 12 : 3;
  const back = ((d.getMonth() - (fyStartMonth - 1) + 12) % 12) % months;
  return new Date(d.getFullYear(), d.getMonth() - back, 1);
}

/** The SVAR unit for a fiscal year (`fy`) or quarter (`fq`) with this start month. */
export function fiscalUnit(kind: "fy" | "fq", fyStartMonth: number): string {
  if (kind === "fy" && fyStartMonth === 1) return "year";
  if (kind === "fq" && (fyStartMonth - 1) % 3 === 0) return "quarter";
  const name = `${kind}${fyStartMonth}`;
  if (registered.has(name)) return name;
  const months = kind === "fy" ? 12 : 3;
  const start = (d: Date) => fiscalUnitStart(kind, fyStartMonth, d);
  const next = (d: Date) => {
    const s = start(d);
    return new Date(s.getFullYear(), s.getMonth() + months, 1);
  };
  const dayCount = (d?: Date) => (d ? days(start(d), next(d)) : months === 3 ? 91 : 365);
  registerScaleUnit(name, {
    start,
    end: (d: Date) => new Date(next(d).getTime() - 1),
    isSame: (a: Date, b: Date) => start(a).getTime() === start(b).getTime(),
    add: (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n * months, d.getDate()),
    diff: (a: Date, b: Date) => days(b, a) / dayCount(b),
    smallerCount: { month: months, week: (d: Date) => dayCount(d) / 7, day: (d: Date) => dayCount(d), hour: (d: Date) => dayCount(d) * 24 },
    biggerCount: kind === "fq" ? { year: 4 } : {},
  });
  registered.add(name);
  return name;
}

/** The label of the calendar period of `kind` that contains `date`. */
function labelFor(calendar: Calendar, kind: "fy" | "quarter" | "month" | "week", date: Date, short = false): string {
  const iso = fromLocal(date);
  const p = calendar.periods.find((x) => x.kind === kind && x.start <= iso && x.end >= iso);
  if (!p) return kind === "month" ? date.toLocaleString("en", { month: "short" }) : "";
  if (short && kind === "quarter") return p.label.split(" ")[0] ?? p.label;
  if (short && kind === "month") return p.label.split(" ")[0] ?? p.label;
  return p.label;
}

export function fiscalScales(zoom: TimelineZoom, calendar: Calendar): IScaleConfig[] {
  const fy = fiscalUnit("fy", calendar.fiscalYearStartMonth);
  const fq = fiscalUnit("fq", calendar.fiscalYearStartMonth);
  switch (zoom) {
    case "week":
      return [
        { unit: "month", step: 1, format: (d: Date) => labelFor(calendar, "month", d) },
        { unit: "week", step: 1, format: (d: Date) => `W${isoWeek(d)}` },
      ];
    case "month":
      return [
        { unit: fq, step: 1, format: (d: Date) => labelFor(calendar, "quarter", d) },
        { unit: "month", step: 1, format: (d: Date) => labelFor(calendar, "month", d, true) },
      ];
    case "quarter":
      return [
        { unit: fy, step: 1, format: (d: Date) => labelFor(calendar, "fy", d) },
        { unit: fq, step: 1, format: (d: Date) => labelFor(calendar, "quarter", d, true) },
      ];
    case "fy":
      return [
        { unit: fy, step: 1, format: (d: Date) => labelFor(calendar, "fy", d) },
        { unit: fq, step: 1, format: (d: Date) => labelFor(calendar, "quarter", d, true) },
      ];
  }
}

/** Width of the smallest scale cell per zoom. */
export function cellWidthFor(zoom: TimelineZoom): number {
  return { week: 44, month: 96, quarter: 180, fy: 64 }[zoom];
}

/** The chart's date range: the calendar's periods, whole units at each end. */
export function chartRange(calendar: Calendar): { start: Date; end: Date } | null {
  const fys = calendar.periods.filter((p) => p.kind === "fy");
  const months = calendar.periods.filter((p) => p.kind === "month");
  const first = months[0] ?? fys[0];
  const last = months.at(-1) ?? fys.at(-1);
  if (!first || !last) return null;
  return { start: toLocal(first.start), end: new Date(toLocal(last.end).getTime() + DAY) };
}
