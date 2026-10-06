import { Buffer } from "node:buffer";
import { DomainError, elapsedFraction, isPredicate, type FilterGroupT, type Predicate, type QueryRequest } from "@budget/domain";
import { sanitize } from "./compile-filter.js";
import { RATIO, elapsedDay, resolveOrder, type CompileOptions, type OrderKey } from "./compile-query.js";

const SUPPORTED_MEASURES = new Set(["budget", "budget_in_period", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct", "ahead_of_plan_abs"]);

/** Grouped or total rows over the base measures: no KPI targets, template, date split or envelope scope. */
function aggregateShape(q: QueryRequest, opts: CompileOptions): boolean {
  if (q.grain !== "total" || q.templateId !== undefined || q.targets.length > 0 || opts.groupDates || opts.envelopeIds !== undefined) return false;
  return q.measures.every((m) => SUPPORTED_MEASURES.has(m));
}

/**
 * Grouped rows and totals in BigQuery SQL (spec §6.2 routing rule, ADR-042): the same columns,
 * order keys and cursor as `compileQuery` / `compileTotals`, computed as sets (budget, spend and
 * projected spend per envelope, joined, grouped) against the warehouse replica (Datastream:
 * `<dataset>.envelope`, `envelope_version`, `spend_fact`, …). UUIDs are STRING there, `ltree`
 * paths are dot-joined STRINGs, and there is no RLS: every table is cut to the workspace here.
 * Spend is summed from `spend_fact` (BigQuery scans it; no monthly table needed). Filters are the
 * dimension predicates, envelope status and is_leaf; anything else stays on Postgres.
 */

export interface CompiledBqQuery {
  sql: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
  orderKeys: OrderKey[];
}

class BqBuilder {
  readonly params: Record<string, unknown> = {};
  readonly types: Record<string, string | string[]> = {};
  private n = 0;
  p(value: unknown, type: string | string[] = "STRING"): string {
    this.n += 1;
    const name = `p${this.n}`;
    this.params[name] = value;
    this.types[name] = type;
    return `@${name}`;
  }
}

const DIMENSION_OPS = new Set(["eq", "neq", "in", "nin", "is_empty", "not_empty", "descends_from"]);

function predicateSupported(p: Predicate): boolean {
  if (p.field.kind === "dimension") return DIMENSION_OPS.has(p.op);
  if (p.field.kind === "attr") return (p.field.key === "status" && ["eq", "neq", "in"].includes(p.op)) || (p.field.key === "is_leaf" && p.op === "eq" && typeof p.value === "boolean");
  return false;
}
function filterSupported(g: FilterGroupT): boolean {
  return g.children.every((c) => (isPredicate(c) ? predicateSupported(c) : filterSupported(c)));
}

/** Whether BigQuery can answer this query: grouped rows or totals over the base measures, with the filters above. */
export function bigQuerySupported(q: QueryRequest, opts: CompileOptions = {}): boolean {
  // Unallocated holdings (ADR-059) are computed on Postgres only, for now.
  return aggregateShape(q, opts) && q.asOf === undefined && q.compareTo === undefined && q.unallocated !== true && filterSupported(q.filter ?? { logic: "and", children: [] });
}

const TABLE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,2}$/;
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map(String);

function compileFilterBq(g: FilterGroupT, b: BqBuilder, t: (name: string) => string): string {
  if (g.children.length === 0) return g.not ? "FALSE" : "TRUE";
  const parts = g.children.map((c) => `(${isPredicate(c) ? compilePredicateBq(c, b, t) : compileFilterBq(c, b, t)})`);
  const joined = parts.join(g.logic === "and" ? " AND " : " OR ");
  return g.not ? `NOT (${joined})` : joined;
}

function compilePredicateBq(p: Predicate, b: BqBuilder, t: (name: string) => string): string {
  if (p.field.kind === "attr") {
    if (p.field.key === "is_leaf") return `${p.value ? "NOT " : ""}EXISTS (SELECT 1 FROM ${t("envelope")} c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED')`;
    if (p.op === "in") return `e.status IN UNNEST(${b.p(list(p.value), ["STRING"])})`;
    return `e.status ${p.op === "neq" ? "<>" : "="} ${b.p(String(p.value))}`;
  }
  if (p.field.kind !== "dimension") throw new DomainError("VALIDATION", "not a BigQuery filter");
  const key = p.field.key;
  const values = (cond: string) =>
    `SELECT ed.envelope_id FROM ${t("envelope_dimension")} ed JOIN ${t("dimension")} d ON d.id = ed.dimension_id JOIN ${t("dimension_value")} dv ON dv.id = ed.value_id WHERE d.key = ${b.p(key)}${cond}`;
  switch (p.op) {
    case "eq":
      return `e.id IN (${values(` AND dv.code = ${b.p(String(p.value))}`)})`;
    case "neq":
      return `e.id NOT IN (${values(` AND dv.code = ${b.p(String(p.value))}`)})`;
    case "in":
      return `e.id IN (${values(` AND dv.code IN UNNEST(${b.p(list(p.value), ["STRING"])})`)})`;
    case "nin":
      return `e.id NOT IN (${values(` AND dv.code IN UNNEST(${b.p(list(p.value), ["STRING"])})`)})`;
    case "is_empty":
      return `e.id NOT IN (${values("")})`;
    case "not_empty":
      return `e.id IN (${values("")})`;
    case "descends_from":
      // ltree `path <@ ancestor` as dot-joined strings: the ancestor itself or anything under it.
      return `e.id IN (SELECT ed.envelope_id FROM ${t("envelope_dimension")} ed JOIN ${t("dimension")} d ON d.id = ed.dimension_id JOIN ${t("dimension_value")} dv ON dv.id = ed.value_id
        JOIN ${t("dimension_value")} anc ON anc.dimension_id = dv.dimension_id AND anc.code IN UNNEST(${b.p(list(p.value), ["STRING"])})
        WHERE d.key = ${b.p(key)} AND (dv.path = anc.path OR STARTS_WITH(dv.path, CONCAT(anc.path, '.'))))`;
    default:
      throw new DomainError("VALIDATION", `op ${p.op} is not a BigQuery filter`);
  }
}

function ratioBq(mk: string): string {
  switch (mk) {
    case "pace_index":
      return `SAFE_DIVIDE(SAFE_DIVIDE(SUM(m.actual), SUM(m.budget_in_period)), @elapsed)`;
    case "variance_pct":
      return `SAFE_DIVIDE(SUM(m.projected) - SUM(m.budget), SUM(m.budget))`;
    case "projected_close_pct":
      return `SAFE_DIVIDE(SUM(m.projected), SUM(m.budget))`;
    case "spend_to_date_pct":
      return `SAFE_DIVIDE(SUM(m.actual), SUM(m.budget))`;
    default:
      throw new Error(mk);
  }
}

function base(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions, dataset: string, dims: string[]) {
  if (!TABLE.test(dataset)) throw new DomainError("VALIDATION", "BigQuery dataset must be [project.]dataset");
  if (!bigQuerySupported(q, opts)) throw new DomainError("VALIDATION", "query shape is not supported on BigQuery");
  const b = new BqBuilder();
  const t = (name: string) => `\`${dataset}.${name}\``;
  const ws = b.p(q.workspaceId);
  const pStart = `CAST(${b.p(period.start)} AS DATE)`;
  const pEnd = `CAST(${b.p(period.end)} AS DATE)`;
  b.params["elapsed"] = elapsedFraction(period, elapsedDay(today, opts)).toString();
  b.types["elapsed"] = "BIGNUMERIC";
  const where = compileFilterBq(q.filter ?? { logic: "and", children: [] }, b, t);
  const withProjections = opts.hasProjections !== false;
  const dimCtes = dims
    .map(
      (k, i) => `,
    d${i} AS (
      SELECT ed.envelope_id, dv.code, dv.label
      FROM ${t("envelope_dimension")} ed JOIN sel ON sel.id = ed.envelope_id JOIN ${t("dimension")} d ON d.id = ed.dimension_id JOIN ${t("dimension_value")} dv ON dv.id = ed.value_id
      WHERE d.key = ${b.p(k)}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY ed.envelope_id ORDER BY dv.code) = 1
    )`,
    )
    .join("");
  // T-5: demo envelopes and demo facts are excluded once the workspace has a real budget (same
  // rule as the Postgres dialect, compile-query.ts) — a pure-demo workspace shows them with no
  // caller plumbing needed; `includeDemo` forces them in unconditionally. `demo_mode` computes
  // "still pure demo" once per statement. projection_fact has no `demo` column (the demo dataset
  // never writes projections), so proj below is left unfiltered.
  const includeDemo = q.includeDemo === true;
  const pureDemo = "(SELECT pure FROM demo_mode)";
  const demoModeCte = includeDemo
    ? ""
    : `demo_mode AS (
      SELECT NOT EXISTS (SELECT 1 FROM ${t("envelope")} r WHERE r.workspace_id = ${ws} AND NOT r.demo AND r.status <> 'ARCHIVED') AS pure
    ),
    `;
  const demoFilter = (column: string) => (includeDemo ? "" : ` AND (NOT ${column} OR ${pureDemo})`);
  const ctes = `
    ${demoModeCte}sel AS (
      SELECT e.id, e.status, e.start_date, e.end_date FROM ${t("envelope")} e
      WHERE e.workspace_id = ${ws} AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart}${demoFilter("e.demo")} AND (${where})
    ),
    bud AS (
      SELECT v.envelope_id, v.amount_reporting AS budget
      FROM ${t("envelope_version")} v JOIN sel ON sel.id = v.envelope_id
      WHERE v.amount_type = 'BUDGET' AND v.status IN ('APPROVED', 'SUPERSEDED') AND v.approved_at <= CURRENT_TIMESTAMP()
      QUALIFY ROW_NUMBER() OVER (PARTITION BY v.envelope_id ORDER BY v.approved_at DESC, v.version_no DESC) = 1
    ),
    act AS (
      SELECT sf.envelope_id, SUM(sf.amount_reporting) AS actual
      FROM ${t("spend_fact")} sf JOIN sel ON sel.id = sf.envelope_id
      WHERE sf.workspace_id = ${ws} AND sf.period_date BETWEEN ${pStart} AND ${pEnd} AND sf.superseded_at IS NULL${demoFilter("sf.demo")}
      GROUP BY sf.envelope_id
    )${
      withProjections
        ? `,
    proj AS (
      SELECT envelope_id, projected FROM (
        SELECT x.envelope_id, x.source_run_id, SUM(IF(x.period_date BETWEEN ${pStart} AND ${pEnd}, x.value_reporting, NULL)) AS projected, MAX(x.loaded_at) AS loaded_at
        FROM ${t("projection_fact")} x JOIN sel ON sel.id = x.envelope_id
        WHERE x.workspace_id = ${ws} AND x.metric = 'spend' AND x.superseded_at IS NULL
        GROUP BY x.envelope_id, x.source_run_id
      )
      QUALIFY ROW_NUMBER() OVER (PARTITION BY envelope_id ORDER BY loaded_at DESC) = 1
    )`
        : ""
    },
    m AS (
      SELECT sel.id AS envelope_id, sel.status, b.budget,
        -- The budget's share of the period (days of overlap / days), as the Postgres planner.
        b.budget * SAFE_DIVIDE(DATE_DIFF(LEAST(sel.end_date, ${pEnd}), GREATEST(sel.start_date, ${pStart}), DAY) + 1, DATE_DIFF(sel.end_date, sel.start_date, DAY) + 1) AS budget_in_period,
        COALESCE(a.actual, 0) AS actual, ${withProjections ? "COALESCE(p.projected, 0)" : "CAST(0 AS NUMERIC)"} AS projected
      FROM sel LEFT JOIN bud b ON b.envelope_id = sel.id LEFT JOIN act a ON a.envelope_id = sel.id${withProjections ? " LEFT JOIN proj p ON p.envelope_id = sel.id" : ""}
    )${dimCtes}`;
  const measures = [...new Set(q.measures)];
  const measureAgg = measures
    .map((mk) => {
      if (RATIO.has(mk)) return `IF(SUM(m.budget) > 0, ${ratioBq(mk)}, NULL) AS ${mk}`;
      if (mk === "remaining") return `SUM(m.budget - m.actual) AS remaining`;
      if (mk === "variance_abs") return `SUM(m.projected - m.budget) AS variance_abs`;
      // ADR-064: the group's spend less its share of the budget for the time gone (the Postgres rows' sum).
      if (mk === "ahead_of_plan_abs") return `SUM(m.actual) - COALESCE(SUM(m.budget_in_period), 0) * @elapsed AS ahead_of_plan_abs`;
      return `SUM(m.${mk}) AS ${mk}`;
    })
    .join(", ");
  return { b, ctes, measureAgg, measures };
}

const NUMERIC = new Set(["budget", "budget_in_period", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct", "ahead_of_plan_abs", "leaf_count", "pending_count"]);

function keysetAfterBq(order: OrderKey[], values: Array<string | null>, b: BqBuilder): string {
  const typed = (col: string, v: string) => (NUMERIC.has(col) ? `CAST(${b.p(v)} AS BIGNUMERIC)` : b.p(v));
  const branches: string[] = [];
  order.forEach((o, i) => {
    const v = values[i];
    if (v === null || v === undefined) return;
    const prefix = order.slice(0, i).map((p, j) => {
      const pv = values[j];
      return pv === null || pv === undefined ? `q.${p.col} IS NULL` : `q.${p.col} = ${typed(p.col, pv)}`;
    });
    branches.push([...prefix, `(q.${o.col} ${o.dir === "asc" ? ">" : "<"} ${typed(o.col, v)} OR q.${o.col} IS NULL)`].join(" AND "));
  });
  return branches.length ? branches.map((x) => `(${x})`).join(" OR ") : "FALSE";
}

/** Grouped rows on BigQuery: the columns, order keys and cursor of `compileQuery`'s grouped rows. */
export function compileAggregateBq(q: QueryRequest, period: { start: string; end: string }, today: string, dataset: string, opts: CompileOptions = {}): CompiledBqQuery {
  if (q.groupBy.length === 0) throw new DomainError("VALIDATION", "compileAggregateBq needs groupBy");
  const keys = q.groupBy.map(sanitize);
  const { b, ctes, measureAgg, measures } = base(q, period, today, opts, dataset, q.groupBy);
  const columns = new Set<string>([...keys.flatMap((k) => [`dim_${k}`, `lbl_${k}`]), ...measures, "leaf_count", "pending_count"]);
  const orderKeys = resolveOrder(q, columns, keys.map((k) => `dim_${k}`), []);
  let after = "TRUE";
  if (q.cursor !== undefined) {
    const parsed = JSON.parse(Buffer.from(q.cursor, "base64url").toString()) as Array<string | null>;
    if (!Array.isArray(parsed) || parsed.length !== orderKeys.length) throw new DomainError("VALIDATION", "cursor does not match this query's sort");
    after = keysetAfterBq(orderKeys, parsed, b);
  }
  const order = orderKeys.map((o) => `q.${o.col} ${o.dir.toUpperCase()} NULLS LAST`).join(", ");
  const joins = q.groupBy.map((_, i) => ` LEFT JOIN d${i} ON d${i}.envelope_id = m.envelope_id`).join("");
  const groupSql = `SELECT ${keys.map((k, i) => `d${i}.code AS dim_${k}, d${i}.label AS lbl_${k}`).join(", ")}, ${measureAgg}, COUNT(*) AS leaf_count, SUM(IF(m.status = 'PENDING', 1, 0)) AS pending_count
       FROM m${joins}
       GROUP BY ${q.groupBy.map((_, i) => `d${i}.code, d${i}.label`).join(", ")}`;
  const limit = b.p(q.limit + 1, "INT64");
  return { sql: `WITH ${ctes} SELECT * FROM (${groupSql}) q WHERE ${after} ORDER BY ${order} LIMIT ${limit}`, params: b.params, types: b.types, orderKeys };
}

/** Totals on BigQuery, as `compileTotals` returns them. */
export function compileAggregateTotalsBq(q: QueryRequest, period: { start: string; end: string }, today: string, dataset: string, opts: CompileOptions = {}): CompiledBqQuery {
  const { b, ctes, measureAgg } = base(q, period, today, opts, dataset, []);
  return { sql: `WITH ${ctes} SELECT ${measureAgg}, COUNT(*) AS leaf_count FROM m`, params: b.params, types: b.types, orderKeys: [] };
}
