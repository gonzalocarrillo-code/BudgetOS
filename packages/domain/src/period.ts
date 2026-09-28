import type { PeriodSpec } from "./query.js";

/**
 * A PeriodSpec as dates (yyyy-MM-dd, both inclusive), for a given `today` and the workspace's fiscal
 * year start month (1 = January). Fiscal keys: `FY2026` (the fiscal year that starts in 2026),
 * `2026-Q3` (third fiscal quarter of FY2026) and `2026-07` (a calendar month).
 */
export interface DateRange {
  start: string;
  end: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)); // m is 0-based and may overflow
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Start of the fiscal year that contains `today`. */
function fiscalYearStart(today: string, startMonth: number): Date {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return utc(m >= startMonth ? y : y - 1, startMonth - 1, 1);
}

/**
 * A workspace's own periods (the `fiscal_period` rows, product feedback 7 / ADR-041): its quarters
 * (4-4-5 or any boundaries), months, years and custom partitions ("Black Friday 2026").
 */
export interface CalendarPeriod {
  key: string;
  kind: string; // month | quarter | year | custom
  start: string;
  end: string;
}

/**
 * With a `calendar`, the workspace's own periods win: a fiscal key resolves to its row, and "this
 * month / quarter / year" to the row of that kind that contains `today`. Without one (or when no
 * row applies), the computed rule: calendar months, quarters of three months from the fiscal year
 * start.
 */
export function resolvePeriod(spec: PeriodSpec, today: string, fiscalYearStartMonth = 1, calendar: readonly CalendarPeriod[] = []): DateRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be yyyy-MM-dd, got ${today}`);
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) throw new Error("fiscalYearStartMonth must be 1..12");
  if (calendar.length) {
    if (spec.kind === "fiscal") {
      const row = calendar.find((c) => c.key === spec.key);
      if (row) return { start: row.start, end: row.end };
    }
    if (spec.kind === "relative" && (spec.preset === "current_month" || spec.preset === "current_quarter" || spec.preset === "current_year" || spec.preset === "ytd")) {
      const kind = spec.preset === "current_month" ? "month" : spec.preset === "current_quarter" ? "quarter" : "year";
      const row = calendar.find((c) => c.kind === kind && c.start <= today && c.end >= today);
      if (row) return spec.preset === "ytd" ? { start: row.start, end: today } : { start: row.start, end: row.end };
    }
  }
  const fyStart = fiscalYearStart(today, fiscalYearStartMonth);
  switch (spec.kind) {
    case "range":
      if (spec.start > spec.end) throw new Error("period start is after its end");
      return { start: spec.start, end: spec.end };
    case "fiscal": {
      const fy = /^FY(\d{4})$/.exec(spec.key);
      if (fy) {
        const s = utc(Number(fy[1]), fiscalYearStartMonth - 1, 1);
        return { start: iso(s), end: iso(utc(s.getUTCFullYear() + 1, s.getUTCMonth(), 0)) };
      }
      const q = /^(\d{4})-Q([1-4])$/.exec(spec.key);
      if (q) {
        const s = utc(Number(q[1]), fiscalYearStartMonth - 1 + (Number(q[2]) - 1) * 3, 1);
        return { start: iso(s), end: iso(utc(s.getUTCFullYear(), s.getUTCMonth() + 3, 0)) };
      }
      const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(spec.key);
      if (m) return { start: `${m[1]}-${m[2]}-01`, end: iso(utc(Number(m[1]), Number(m[2]), 0)) };
      throw new Error(`unknown fiscal period key ${spec.key}`);
    }
    case "relative": {
      const y = Number(today.slice(0, 4));
      const mo = Number(today.slice(5, 7)) - 1;
      switch (spec.preset) {
        case "current_month":
          return { start: iso(utc(y, mo, 1)), end: iso(utc(y, mo + 1, 0)) };
        case "current_quarter": {
          const offset = (mo - (fiscalYearStartMonth - 1) + 12) % 12;
          const s = utc(y, mo - (offset % 3), 1);
          return { start: iso(s), end: iso(utc(s.getUTCFullYear(), s.getUTCMonth() + 3, 0)) };
        }
        case "current_year":
          return { start: iso(fyStart), end: iso(utc(fyStart.getUTCFullYear() + 1, fyStart.getUTCMonth(), 0)) };
        case "ytd":
          return { start: iso(fyStart), end: today };
        case "last_30_days":
          return { start: addDays(today, -29), end: today };
        case "last_90_days":
          return { start: addDays(today, -89), end: today };
        case "next_90_days":
          return { start: today, end: addDays(today, 89) };
      }
      throw new Error(`unknown period preset ${String(spec.preset)}`);
    }
  }
}

/**
 * The fiscal periods of one year (ADR-041), keyed as `resolvePeriod` reads them: `FY2027`,
 * `2027-Q1`…`2027-Q4` (the year the fiscal year starts in), and months — calendar months
 * (`2027-07`) for the `calendar` pattern, fiscal months `FY2027-P01`…`P12` for the week-based
 * 4-4-5 / 4-5-4 / 5-4-4 patterns (13-week quarters from the first day of the start month; the last
 * quarter runs to the day before the next fiscal year).
 */
export type PeriodPattern = "calendar" | "445" | "454" | "544";

export function fiscalYearPeriods(fiscalYear: number, startMonth: number, pattern: PeriodPattern): CalendarPeriod[] {
  const start = utc(fiscalYear, startMonth - 1, 1);
  const end = utc(fiscalYear + 1, startMonth - 1, 0);
  const out: CalendarPeriod[] = [{ key: `FY${fiscalYear}`, kind: "year", start: iso(start), end: iso(end) }];
  if (pattern === "calendar") {
    for (let q = 0; q < 4; q += 1) {
      const qs = utc(fiscalYear, startMonth - 1 + q * 3, 1);
      out.push({ key: `${fiscalYear}-Q${q + 1}`, kind: "quarter", start: iso(qs), end: iso(utc(qs.getUTCFullYear(), qs.getUTCMonth() + 3, 0)) });
    }
    for (let m = 0; m < 12; m += 1) {
      const ms = utc(fiscalYear, startMonth - 1 + m, 1);
      out.push({ key: `${ms.getUTCFullYear()}-${String(ms.getUTCMonth() + 1).padStart(2, "0")}`, kind: "month", start: iso(ms), end: iso(utc(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0)) });
    }
    return out;
  }
  const weeks = pattern.split("").map(Number); // weeks per month within a quarter
  let cursor = iso(start);
  let month = 1;
  for (let q = 0; q < 4; q += 1) {
    const qStart = cursor;
    for (const [i, w] of weeks.entries()) {
      const last = q === 3 && i === weeks.length - 1;
      const mEnd = last ? iso(end) : addDays(cursor, w * 7 - 1);
      out.push({ key: `FY${fiscalYear}-P${String(month).padStart(2, "0")}`, kind: "month", start: cursor, end: mEnd });
      cursor = addDays(mEnd, 1);
      month += 1;
    }
    out.push({ key: `${fiscalYear}-Q${q + 1}`, kind: "quarter", start: qStart, end: addDays(cursor, -1) });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.kind === "year" ? -1 : b.kind === "year" ? 1 : a.kind === "quarter" ? -1 : 1));
}
