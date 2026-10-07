import { Decimal } from "decimal.js";
import { DomainError, isPredicate, type FilterGroupT, type Predicate } from "@budget/domain";
import { SqlBuilder, escapeLike } from "./sql-builder.js";
import { compileFilter, sanitize } from "./compile-filter.js";
import type { MetricDef } from "./compile-query.js";

/**
 * EX-2 (ADR-086): totals and a daily series over a **fact scope** — a FilterGroup evaluated on
 * spend_fact / kpi_fact `dimension_values` (e.g. `campaign = A`), independent of budgets — or over
 * the facts matched to a set of envelopes (an envelope-scoped experiment side).
 *
 * - One row per calendar day in [start, min(end, today)]. A day with no fact row for the scope has
 *   `has_data = false` and null metrics: never 0, never interpolated.
 * - A metric with no fact row on a day is null on that day (spend and each KPI separately).
 * - Derived metrics (CPA, ROAS, …) are computed here, at query time: Σnumerator / Σdenominator over
 *   the days that have data (weighted, never an average of daily ratios). Budget-based metrics have
 *   no meaning on facts and are refused.
 * - Superseded facts are never read (ADR-071). Demo facts follow T-5 / ADR-082: excluded once the
 *   workspace has a real (non-demo, live) budget, unless `includeDemo`.
 */

export interface FactScopeRequest {
  workspaceId: string;
  /** Predicates over the facts' own dimension_values (dimension predicates only). Omitted: no fact filter. */
  filter?: FilterGroupT | undefined;
  /** Only facts matched to these envelopes (an envelope-scoped side, resolved by the planner). */
  envelopeIds?: readonly string[] | undefined;
  /**
   * The caller's read scope over envelopes (dimension / attr predicates on alias `e`): a fact counts
   * only when it is matched to an envelope inside it. Omitted: no restriction (unrestricted readers).
   */
  envelopeScope?: FilterGroupT | undefined;
  start: string;
  end: string;
  includeDemo?: boolean | undefined;
  /** kpi_fact metrics to sum (each derived metric's own kpi references are added). */
  kpiMetrics: readonly string[];
  /** Derived metrics to compute, by key. */
  derived?: ReadonlyMap<string, MetricDef> | undefined;
}

export interface CompiledFactScope {
  sql: string;
  values: unknown[];
  /** Result column per kpi_fact metric and per derived metric. */
  columns: { kpi: Array<{ metric: string; col: string }>; derived: Array<{ key: string; col: string }> };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The window the series covers: [start, min(end, today)]; null when it has not started yet. */
export function factWindow(start: string, end: string, today: string): { start: string; last: string } | null {
  const last = end < today ? end : today;
  return start > last ? null : { start, last };
}

/** Whether a metric can be computed on facts alone (no `budget` numerator or denominator). */
export const factComputable = (def: MetricDef): boolean => def.numerator !== "budget" && def.denominator !== "budget";

const invalid = (message: string, p?: Predicate) => new DomainError("VALIDATION", message, p ? { field: p.field, op: p.op } : undefined);

/**
 * A FilterGroup over fact `dimension_values` (alias `alias`). Dimension predicates only; contains /
 * starts_with match the value code or its registry label (the org's dimension of that key).
 */
export function compileFactFilter(g: FilterGroupT, b: SqlBuilder, alias: string, ws: string): string {
  if (g.children.length === 0) return g.not ? "FALSE" : "TRUE";
  const parts = g.children.map((c) => (isPredicate(c) ? factPredicate(c, b, alias, ws) : compileFactFilter(c, b, alias, ws)));
  const joined = parts.map((p) => `(${p})`).join(g.logic === "and" ? " AND " : " OR ");
  return g.not ? `NOT (${joined})` : joined;
}

function factPredicate(p: Predicate, b: SqlBuilder, alias: string, ws: string): string {
  if (p.field.kind !== "dimension") throw invalid(`a fact scope filters on dimensions only, not ${p.field.kind}`, p);
  const key = p.field.key;
  const col = `(${alias}.dimension_values ->> ${b.p(key)}::text)`;
  const arr = () => {
    if (!Array.isArray(p.value)) throw invalid(`op ${p.op} needs an array value`, p);
    return p.value.map(String);
  };
  const labelled = (pattern: string) =>
    `(${col} ILIKE ${b.p(pattern)}::text ESCAPE '\\' OR ${col} IN (SELECT dv.code FROM dimension_value dv JOIN dimension d ON d.id = dv.dimension_id
       WHERE d.key = ${b.p(key)}::text AND d.org_id = (SELECT w.org_id FROM workspace w WHERE w.id = ${ws}::uuid) AND (d.workspace_id IS NULL OR d.workspace_id = ${ws}::uuid)
         AND dv.label ILIKE ${b.p(pattern)}::text ESCAPE '\\'))`;
  switch (p.op) {
    case "eq":
      return `${col} = ${b.p(String(p.value))}::text`;
    case "neq":
      // Same meaning as on envelopes: a fact without the dimension is "not this value".
      return `${col} IS DISTINCT FROM ${b.p(String(p.value))}::text`;
    case "in":
      return `${col} = ANY(${b.p(arr())}::text[])`;
    case "nin":
      return `NOT coalesce(${col} = ANY(${b.p(arr())}::text[]), false)`;
    case "is_empty":
      return `coalesce(${col}, '') = ''`;
    case "not_empty":
      return `coalesce(${col}, '') <> ''`;
    case "contains":
      return labelled(`%${escapeLike(String(p.value))}%`);
    case "starts_with":
      return labelled(`${escapeLike(String(p.value))}%`);
    default:
      throw invalid(`op ${p.op} not valid on a fact scope`, p);
  }
}

interface Built {
  b: SqlBuilder;
  ctes: string;
  kpi: Array<{ metric: string; col: string }>;
  derived: Array<{ key: string; col: string; num: string; den: string | null; mult: string }>;
}

function build(r: FactScopeRequest, today: string): Built {
  const b = new SqlBuilder();
  const ws = b.p(r.workspaceId);
  const window = factWindow(r.start, r.end, today);
  // A window that has not started: an empty day list (generate_series of an inverted range).
  const pStart = `${b.p(window?.start ?? r.start)}::date`;
  const pLast = `${b.p(window?.last ?? addDays(r.start, -1))}::date`;
  const derivedDefs = [...(r.derived ?? new Map<string, MetricDef>()).entries()];
  for (const [key, def] of derivedDefs) {
    if (!factComputable(def)) throw new DomainError("VALIDATION", `metric ${key} reads budget and cannot be computed on facts`, { metric: key });
    for (const ref of [def.numerator, def.denominator]) {
      if (ref !== null && ref !== "spend" && !ref.startsWith("kpi:")) throw new DomainError("VALIDATION", `metric ${key} references unknown source ${ref}`);
    }
  }
  const kpiNames = [...new Set([...r.kpiMetrics, ...derivedDefs.flatMap(([, d]) => [d.numerator, d.denominator ?? ""].filter((x) => x.startsWith("kpi:")).map((x) => x.slice(4)))])].sort();
  const kpi = kpiNames.map((metric, i) => ({ metric, col: `k${i}_${sanitize(metric)}` }));
  const colOf = (ref: string) => (ref === "spend" ? "spend" : (kpi.find((k) => k.metric === ref.slice(4))?.col as string));
  const derived = derivedDefs.map(([key, def], i) => ({
    key,
    col: `d${i}_${sanitize(key)}`,
    num: colOf(def.numerator),
    den: def.denominator === null ? null : colOf(def.denominator),
    mult: def.multiplier === undefined || new Decimal(def.multiplier).equals(1) ? "" : ` * ${b.p(def.multiplier)}::numeric`,
  }));

  const includeDemo = r.includeDemo === true;
  const demo = (alias: string) => (includeDemo ? "" : ` AND (NOT ${alias}.demo OR (SELECT pure FROM demo_mode))`);
  const demoCte = includeDemo ? "" : `demo_mode AS (SELECT NOT EXISTS (SELECT 1 FROM envelope r WHERE r.workspace_id = ${ws}::uuid AND NOT r.demo AND r.status <> 'ARCHIVED') AS pure),`;
  const scope = (alias: string) => {
    let sql = r.filter ? ` AND (${compileFactFilter(r.filter, b, alias, ws)})` : "";
    if (r.envelopeIds !== undefined) sql += ` AND ${alias}.envelope_id = ANY(${b.p([...r.envelopeIds])}::uuid[])`;
    if (r.envelopeScope !== undefined) {
      const ctx = { workspaceId: r.workspaceId, periodStart: r.start, periodEnd: r.end, today };
      sql += ` AND ${alias}.envelope_id IN (SELECT e.id FROM envelope e WHERE e.workspace_id = ${ws}::uuid AND (${compileFilter(r.envelopeScope, b, ctx)}))`;
    }
    return sql;
  };
  const kpiSums = kpi.map((k) => `, sum(kf.value) FILTER (WHERE kf.metric = ${b.p(k.metric)}::text) AS ${k.col}`).join("");
  const ctes = `${demoCte}
    days AS (SELECT d::date AS day FROM generate_series(${pStart}, ${pLast}, interval '1 day') d),
    s AS (
      SELECT sf.period_date AS day, sum(sf.amount_reporting) AS spend, count(*) AS n
      FROM spend_fact sf
      WHERE sf.workspace_id = ${ws}::uuid AND sf.period_date BETWEEN ${pStart} AND ${pLast} AND sf.superseded_at IS NULL${demo("sf")}${scope("sf")}
      GROUP BY sf.period_date
    ),
    k AS (
      SELECT kf.period_date AS day, count(*) AS n${kpiSums}
      FROM kpi_fact kf
      WHERE kf.workspace_id = ${ws}::uuid AND kf.period_date BETWEEN ${pStart} AND ${pLast} AND kf.superseded_at IS NULL${demo("kf")}${scope("kf")}
      GROUP BY kf.period_date
    ),
    series AS (
      SELECT days.day, (coalesce(s.n, 0) + coalesce(k.n, 0)) > 0 AS has_data, s.spend${kpi.map((x) => `, k.${x.col}`).join("")}
      FROM days LEFT JOIN s ON s.day = days.day LEFT JOIN k ON k.day = days.day
    )`;
  return { b, ctes, kpi, derived };
}

/** One row per day: period_date (text), has_data, spend, one column per kpi metric and per derived metric. */
export function compileFactSeries(r: FactScopeRequest, today: string): CompiledFactScope {
  const { b, ctes, kpi, derived } = build(r, today);
  const derivedCols = derived.map((d) => (d.den === null ? `, (${d.num}${d.mult}) AS ${d.col}` : `, (${d.num}${d.mult} / NULLIF(${d.den}, 0)) AS ${d.col}`)).join("");
  const sql = `WITH ${ctes}
    SELECT day::text AS period_date, has_data, spend${kpi.map((k) => `, ${k.col}`).join("")}${derivedCols}
    FROM series ORDER BY day`;
  return { sql, values: b.values, columns: { kpi: kpi.map(({ metric, col }) => ({ metric, col })), derived: derived.map(({ key, col }) => ({ key, col })) } };
}

/**
 * One row of totals over the days with data: days_in_window, days_with_data, spend, each kpi
 * metric, and each derived metric as Σnumerator / Σdenominator. A metric with no fact row at all is null.
 */
export function compileFactTotals(r: FactScopeRequest, today: string): CompiledFactScope {
  const { b, ctes, kpi, derived } = build(r, today);
  const derivedCols = derived.map((d) => (d.den === null ? `, (sum(${d.num})${d.mult}) AS ${d.col}` : `, (sum(${d.num})${d.mult} / NULLIF(sum(${d.den}), 0)) AS ${d.col}`)).join("");
  const sql = `WITH ${ctes}
    SELECT count(*)::int AS days_in_window, (count(*) FILTER (WHERE has_data))::int AS days_with_data, sum(spend) AS spend${kpi.map((k) => `, sum(${k.col}) AS ${k.col}`).join("")}${derivedCols}
    FROM series`;
  return { sql, values: b.values, columns: { kpi: kpi.map(({ metric, col }) => ({ metric, col })), derived: derived.map(({ key, col }) => ({ key, col })) } };
}
