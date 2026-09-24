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

export function resolvePeriod(spec: PeriodSpec, today: string, fiscalYearStartMonth = 1): DateRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be yyyy-MM-dd, got ${today}`);
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) throw new Error("fiscalYearStartMonth must be 1..12");
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
