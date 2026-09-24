import { Buffer } from "node:buffer";
import { DomainError, type QueryRequest } from "@budget/domain";
import { SqlBuilder } from "./sql-builder.js";
import { compileFilter, filterMetrics, sanitize, type CompileCtx } from "./compile-filter.js";

export interface OrderKey {
  col: string;
  dir: "asc" | "desc";
}

/** `orderKeys` is the full keyset order (sort keys + tie-breaks); `pageOf` builds the next cursor from it. */
export interface CompiledQuery {
  sql: string;
  values: unknown[];
  orderKeys: OrderKey[];
}

const RATIO = new Set(["pace_index", "variance_pct", "projected_close_pct", "spend_to_date_pct"]);

interface Base {
  b: SqlBuilder;
  measuresCte: string;
  where: string;
  measureAgg: string;
  measures: string[];
}

function compileBase(q: QueryRequest, period: { start: string; end: string }, today: string): Base {
  if (q.grain !== "total") throw new DomainError("VALIDATION", `grain ${q.grain} is not supported by the Postgres planner`);
  if (q.templateId !== undefined) throw new DomainError("VALIDATION", "templateId tree order is not supported by the Postgres planner");
  const b = new SqlBuilder();
  const ctx: CompileCtx = { workspaceId: q.workspaceId, periodStart: period.start, periodEnd: period.end, today };
  const asOf = q.asOf ? `${b.p(q.asOf)}::timestamptz` : "now()";
  const ws = b.p(q.workspaceId);
  const pStart = `${b.p(period.start)}::date`,
    pEnd = `${b.p(period.end)}::date`;
  const elapsedFrac = `LEAST(1, GREATEST(0, (${b.p(today)}::date - ${pStart}::date + 1)::numeric / NULLIF((${pEnd}::date - ${pStart}::date + 1),0)))`;

  // KPI columns requested via targets[] or read by the filter → kpi_<metric> per envelope
  // (derived metrics computed from spend & kpi facts, never stored).
  const filter = q.filter ?? { logic: "and" as const, children: [] };
  const kpiMetrics = [...new Set([...q.targets, ...filterMetrics(filter)])];
  const kpiCols = kpiMetrics.map((mk) => `, (${derivedMetricSql(mk, b, pStart, pEnd, ws)}) AS kpi_${sanitize(mk)}`).join("");

  // Budget as of a timestamp is the latest version approved by then. Versions approved earlier are
  // SUPERSEDED now (spec §7.3), so status alone cannot select them.
  const measuresCte = `
    m AS (
      SELECT e.id AS envelope_id,
        (SELECT v.amount_reporting FROM envelope_version v WHERE v.envelope_id = e.id AND v.amount_type = 'BUDGET'
           AND v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= ${asOf}
           ORDER BY v.approved_at DESC LIMIT 1) AS budget,
        (SELECT coalesce(sum(sf.amount_reporting),0) FROM spend_fact sf WHERE sf.workspace_id = ${ws}::uuid AND sf.envelope_id = e.id AND sf.period_date BETWEEN ${pStart} AND ${pEnd}) AS actual,
        (SELECT coalesce(sum(pf.value_reporting),0) FROM projection_fact pf WHERE pf.workspace_id = ${ws}::uuid AND pf.envelope_id = e.id AND pf.metric='spend'
           AND pf.period_date BETWEEN ${pStart} AND ${pEnd}
           AND pf.source_run_id = (SELECT x.source_run_id FROM projection_fact x WHERE x.workspace_id = ${ws}::uuid AND x.envelope_id = e.id AND x.metric='spend' ORDER BY x.loaded_at DESC LIMIT 1)) AS projected
        ${kpiCols}
      FROM envelope e WHERE e.workspace_id = ${ws}::uuid
        AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart}
    ),
    m2 AS (
      SELECT *, (budget - actual) AS remaining,
        (projected - budget) AS variance_abs,
        CASE WHEN budget > 0 THEN (projected - budget) / budget ELSE NULL END AS variance_pct,
        CASE WHEN budget > 0 THEN actual / budget ELSE NULL END AS spend_to_date_pct,
        CASE WHEN budget > 0 AND ${elapsedFrac} > 0 THEN (actual / budget) / ${elapsedFrac} ELSE NULL END AS pace_index,
        CASE WHEN budget > 0 THEN projected / budget ELSE NULL END AS projected_close_pct
      FROM m
    )`;

  const where = compileFilter(filter, b, ctx);
  const measures = [...new Set(q.measures)];
  const measureAgg = measures
    .map((mk) => {
      if (RATIO.has(mk)) {
        // ratio measures are recomputed from sums, never averaged
        return `CASE WHEN sum(m.budget) > 0 THEN ${ratioExpr(mk, elapsedFrac)} ELSE NULL END AS ${mk}`;
      }
      return `sum(m.${mk}) AS ${mk}`;
    })
    .join(", ");
  return { b, measuresCte, where, measureAgg, measures };
}

export function compileQuery(q: QueryRequest, period: { start: string; end: string }, today: string): CompiledQuery {
  const { b, measuresCte, where, measureAgg, measures } = compileBase(q, period, today);
  const groupKeys = q.groupBy.map(sanitize);
  if (new Set(groupKeys).size !== groupKeys.length) throw new DomainError("VALIDATION", "groupBy keys must be unique");

  // group-by dimension codes as lateral joins
  const dimJoins = q.groupBy
    .map(
      (k, i) => `
    LEFT JOIN LATERAL (
      SELECT dv.code, dv.label FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id JOIN dimension d ON d.id = ed.dimension_id
      WHERE ed.envelope_id = e.id AND d.key = ${b.p(k)}::text LIMIT 1) g${i} ON TRUE`,
    )
    .join("");
  const dimSelect = groupKeys.map((k, i) => `g${i}.code AS dim_${k}, g${i}.label AS lbl_${k}`).join(", ");

  const grouped = q.groupBy.length > 0;
  const kpiSelect = q.targets.map((mk) => `, m.kpi_${sanitize(mk)}`).join("");
  const groupSql = grouped
    ? `SELECT ${dimSelect}, ${measureAgg}, count(*) AS leaf_count,
         sum(CASE WHEN e.status='PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id ${dimJoins}
       WHERE ${where}
       GROUP BY ${q.groupBy.map((_, i) => `g${i}.code, g${i}.label`).join(", ")}`
    : `SELECT e.id AS envelope_id, e.name, e.status::text AS status, e.parent_id, e.dimension_values, ${measures.map((mk) => `m.${mk}`).join(", ")}
         ${kpiSelect},
         (SELECT count(*) FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED')) AS open_alerts,
         (SELECT count(*) FROM thread t WHERE t.anchor_type='envelope' AND t.anchor_id = e.id AND t.status='open') AS open_threads
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id
       WHERE ${where}`;

  const columns = new Set<string>(
    grouped
      ? [...groupKeys.flatMap((k) => [`dim_${k}`, `lbl_${k}`]), ...measures, "leaf_count", "pending_count"]
      : ["envelope_id", "name", "status", "parent_id", ...measures, ...q.targets.map((mk) => `kpi_${sanitize(mk)}`), "open_alerts", "open_threads"],
  );
  const orderKeys = resolveOrder(q, columns, grouped ? groupKeys.map((k) => `dim_${k}`) : ["envelope_id"], grouped ? [] : ["name"]);
  const after = q.cursor === undefined ? "TRUE" : keysetAfter(orderKeys, decodeCursor(q.cursor, orderKeys.length), b);
  const order = orderKeys.map((o) => `q.${o.col} ${o.dir.toUpperCase()} NULLS LAST`).join(", ");
  const sql = `WITH ${measuresCte} SELECT * FROM (${groupSql}) q WHERE ${after} ORDER BY ${order} LIMIT ${b.p(q.limit + 1)}`;
  return { sql, values: b.values, orderKeys };
}

/** One row of totals over every envelope the filter selects; same measure semantics as a group. */
export function compileTotals(q: QueryRequest, period: { start: string; end: string }, today: string): CompiledQuery {
  const { b, measuresCte, where, measureAgg } = compileBase(q, period, today);
  const sql = `WITH ${measuresCte} SELECT ${measureAgg}, count(*) AS leaf_count FROM envelope e JOIN m2 m ON m.envelope_id = e.id WHERE ${where}`;
  return { sql, values: b.values, orderKeys: [] };
}

/**
 * Keyset order: requested sort keys, then a unique tie-break. Offsets drift when rows are inserted
 * between pages; a keyset cursor does not.
 */
function resolveOrder(q: QueryRequest, columns: Set<string>, tieBreak: string[], defaultSort: string[]): OrderKey[] {
  const keys: OrderKey[] = [];
  const seen = new Set<string>();
  const push = (col: string, dir: "asc" | "desc") => {
    if (!seen.has(col)) {
      seen.add(col);
      keys.push({ col, dir });
    }
  };
  const requested = q.sort.length ? q.sort : defaultSort.map((key) => ({ key, dir: "asc" as const }));
  for (const s of requested) {
    const raw = s.key.replace(/^[em]\./, "");
    const col = columns.has(raw) ? raw : columns.has(`dim_${sanitize(raw)}`) ? `dim_${sanitize(raw)}` : null;
    if (col === null) throw new DomainError("VALIDATION", `unknown sort key ${s.key}`, { allowed: [...columns] });
    push(col, s.dir);
  }
  for (const col of tieBreak) push(col, "asc");
  return keys;
}

const UUID_COLS = new Set(["envelope_id", "parent_id"]);
const NUMERIC_COLS = new Set(["budget", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct", "leaf_count", "pending_count", "open_alerts", "open_threads"]);
const castFor = (col: string) => (UUID_COLS.has(col) ? "uuid" : NUMERIC_COLS.has(col) || col.startsWith("kpi_") ? "numeric" : "text");

/** Rows strictly after the cursor row in `ORDER BY … NULLS LAST` order. */
function keysetAfter(order: OrderKey[], values: Array<string | null>, b: SqlBuilder): string {
  const branches: string[] = [];
  order.forEach((o, i) => {
    const v = values[i];
    if (v === null || v === undefined) return; // NULLS LAST: nothing sorts after a null except equal nulls
    const equalPrefix = order.slice(0, i).map((p, j) => {
      const pv = values[j];
      return pv === null || pv === undefined ? `q.${p.col} IS NULL` : `q.${p.col} = ${b.p(pv)}::${castFor(p.col)}`;
    });
    const after = `(q.${o.col} ${o.dir === "asc" ? ">" : "<"} ${b.p(v)}::${castFor(o.col)} OR q.${o.col} IS NULL)`;
    branches.push([...equalPrefix, after].join(" AND "));
  });
  return branches.length ? branches.map((x) => `(${x})`).join(" OR ") : "FALSE";
}

export function encodeCursor(values: Array<string | null>): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeCursor(cursor: string, length: number): Array<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new DomainError("VALIDATION", "malformed cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== length || !parsed.every((v) => v === null || typeof v === "string")) {
    throw new DomainError("VALIDATION", "cursor does not match this query's sort");
  }
  return parsed as Array<string | null>;
}

const cursorValue = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

/** Trims the extra look-ahead row and builds `nextCursor` from the last row returned. */
export function pageOf<R extends Record<string, unknown>>(
  c: CompiledQuery,
  rows: R[],
  limit: number,
): { rows: R[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (rows.length <= limit || last === undefined) return { rows: page, nextCursor: null };
  return { rows: page, nextCursor: encodeCursor(c.orderKeys.map((o) => cursorValue(last[o.col]))) };
}

function ratioExpr(mk: string, elapsedFrac: string): string {
  switch (mk) {
    case "pace_index":
      return `(sum(m.actual)/sum(m.budget)) / NULLIF(${elapsedFrac},0)`;
    case "variance_pct":
      return `(sum(m.projected)-sum(m.budget))/sum(m.budget)`;
    case "projected_close_pct":
      return `sum(m.projected)/sum(m.budget)`;
    case "spend_to_date_pct":
      return `sum(m.actual)/sum(m.budget)`;
    default:
      throw new Error(mk);
  }
}

/** Derived metric over facts for one envelope alias e. `ws` is the workspace placeholder so the fact indexes apply. Reads metric_definition at planning time (cached). */
export function derivedMetricSql(metricKey: string, b: SqlBuilder, pStart: string, pEnd: string, ws: string): string {
  const def = metricRegistry.get(metricKey); // loaded by the planner service from metric_definition
  if (!def) throw new DomainError("VALIDATION", `unknown metric ${metricKey}`);
  const src = (ref: string) => {
    if (ref === "spend") {
      return `(SELECT coalesce(sum(amount_reporting),0) FROM spend_fact WHERE workspace_id = ${ws}::uuid AND envelope_id = e.id AND period_date BETWEEN ${pStart} AND ${pEnd})`;
    }
    if (!ref.startsWith("kpi:")) throw new DomainError("VALIDATION", `metric ${metricKey} references unknown source ${ref}`);
    return `(SELECT coalesce(sum(value),0) FROM kpi_fact WHERE workspace_id = ${ws}::uuid AND envelope_id = e.id AND metric = ${b.p(ref.slice(4))}::text AND period_date BETWEEN ${pStart} AND ${pEnd})`;
  };
  return def.denominator ? `${src(def.numerator)} / NULLIF(${src(def.denominator)},0)` : src(def.numerator);
}

export const metricRegistry = new Map<string, { numerator: string; denominator: string | null }>();
