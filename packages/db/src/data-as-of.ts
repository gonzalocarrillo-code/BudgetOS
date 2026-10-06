import type { Tx } from "./sql.js";

/**
 * How current a workspace's actuals are (HO-003, ADR-062). Spend facts carry one date each; a source
 * whose mapping reads the date as `yyyy-MM` loads a whole month dated by its first day, so its latest
 * facts cover through the end of that month, not just its first day. `through` is the last day the
 * actuals cover (never after today); Home and the Overview count time gone through it, so late data
 * does not read as under-spending.
 *
 * Stale: a daily source more than STALE_AFTER_DAYS behind today; a monthly source whose last whole
 * month is still missing MONTHLY_GRACE_DAYS after that month ended (decision G7).
 */
export const STALE_AFTER_DAYS = 2;
export const MONTHLY_GRACE_DAYS = 10;

export interface DataAsOf {
  /** The latest spend fact's date as stored (a monthly source dates a month by its first day). */
  lastFactDate: string | null;
  /** The last day those actuals cover, capped at today. */
  through: string | null;
  grain: "day" | "month" | null;
  /** Days from `through` to today. */
  staleDays: number | null;
  stale: boolean;
}

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
/** The last day of the month `date` falls in. */
export const endOfMonth = (date: string): string => {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The coverage of the latest actuals, from their date and the date formats of the sources that
 * loaded them. Monthly only when every such source reads its dates by month (a daily feed that
 * landed on the 1st still counts one day). Pure, for tests.
 */
export function coverage(lastFactDate: string | null, formats: ReadonlyArray<string | null>, today: string): DataAsOf {
  if (lastFactDate === null) return { lastFactDate: null, through: null, grain: null, staleDays: null, stale: false };
  const grain = formats.length > 0 && formats.every((f) => f === "yyyy-MM") ? "month" : "day";
  const covered = grain === "month" ? endOfMonth(lastFactDate) : lastFactDate;
  const through = covered > today ? today : covered;
  const staleDays = Math.max(0, Math.round(toDay(today) - toDay(through)));
  let stale: boolean;
  if (grain === "day") stale = staleDays > STALE_AFTER_DAYS;
  else {
    // The month before today's month should be in; it is late once the grace after it has passed.
    const lastWholeMonth = iso(toDay(`${today.slice(0, 7)}-01`) - 1);
    stale = through < lastWholeMonth && toDay(today) - toDay(lastWholeMonth) > MONTHLY_GRACE_DAYS;
  }
  return { lastFactDate, through, grain, staleDays, stale };
}

/** The workspace's latest spend fact and the date formats of the sources that loaded that date. */
export async function dataAsOf(tx: Tx, workspaceId: string, today: string): Promise<DataAsOf> {
  const [last] = await tx.$queryRaw<Array<{ d: string | null }>>`SELECT max(period_date)::text AS d FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL`;
  const lastFactDate = last?.d ?? null;
  if (lastFactDate === null) return coverage(null, [], today);
  // Facts loaded by hand or without a source run count by day.
  const sources = await tx.$queryRaw<Array<{ format: string | null }>>`
    SELECT DISTINCT (SELECT c.value->>'format' FROM jsonb_each(ds.mapping->'columns') c WHERE c.value->>'role' = 'period_date' LIMIT 1) AS format
    FROM spend_fact sf
    LEFT JOIN ingest_run r ON r.id = sf.source_run_id
    LEFT JOIN data_source ds ON ds.id = r.source_id
    WHERE sf.workspace_id = ${workspaceId}::uuid AND sf.period_date = ${lastFactDate}::date AND sf.superseded_at IS NULL`;
  return coverage(lastFactDate, sources.map((s) => s.format), today);
}

/**
 * T-9 (audit, ADR-062 addendum): `CompileOptions.elapsedThrough` for a `QueryRequest.elapsedThrough`
 * choice. `"data"` (the default) resolves to the workspace's data coverage date, the same day Home
 * and the Overview already use; `"today"` keeps counting to the calendar day (no override, so the
 * planner's own `elapsedDay` falls back to today).
 */
export async function resolveElapsedThrough(tx: Tx, workspaceId: string, today: string, requested: "today" | "data"): Promise<string | undefined> {
  if (requested === "today") return undefined;
  const asOf = await dataAsOf(tx, workspaceId, today);
  return asOf.through ?? undefined;
}

/** The latest projection load (HO-012): when, and from which source; null without projections. */
export async function projectionFreshness(tx: Tx, workspaceId: string): Promise<{ loadedAt: string; source: string | null } | null> {
  const [r] = await tx.$queryRaw<Array<{ at: Date; source: string | null }>>`
    SELECT x.loaded_at AS at, ds.name AS source
    FROM projection_fact x LEFT JOIN ingest_run r ON r.id = x.source_run_id LEFT JOIN data_source ds ON ds.id = r.source_id
    WHERE x.workspace_id = ${workspaceId}::uuid AND x.superseded_at IS NULL
    ORDER BY x.loaded_at DESC LIMIT 1`;
  return r ? { loadedAt: r.at.toISOString(), source: r.source } : null;
}
