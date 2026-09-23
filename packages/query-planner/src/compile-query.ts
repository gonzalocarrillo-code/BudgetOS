// packages/query-planner/src/compile-query.ts
import { type QueryRequest } from "@budget/domain";
import { compileFilter, sanitize, type CompileCtx } from "./compile-filter.js";
import { SqlBuilder } from "./sql-builder.js";

export interface CompiledQuery {
  sql: string;
  values: unknown[];
}

export function compileQuery(q: QueryRequest, period: { start: string; end: string }, today: string): CompiledQuery {
  const b = new SqlBuilder();
  const ctx: CompileCtx = { workspaceId: q.workspaceId, periodStart: period.start, periodEnd: period.end, today };
  const asOf = q.asOf ? b.p(q.asOf) : "now()";
  const ws = b.p(q.workspaceId);
  const pStart = b.p(period.start),
    pEnd = b.p(period.end);
  const elapsedFrac = `LEAST(1, GREATEST(0, (${b.p(today)}::date - ${pStart}::date + 1)::numeric / NULLIF((${pEnd}::date - ${pStart}::date + 1),0)))`;

  // KPI columns requested via targets[] → kpi_<metric> per envelope (derived metrics computed from spend & kpi facts)
  const kpiCols = q.targets.map((mk) => `, (${derivedMetricSql(mk, b, pStart, pEnd)}) AS kpi_${sanitize(mk)}`).join("");

  const measuresCte = `
    m AS (
      SELECT e.id AS envelope_id,
        (SELECT v.amount_reporting FROM envelope_version v WHERE v.envelope_id = e.id AND v.status='APPROVED' AND v.approved_at <= ${asOf}
           ORDER BY v.approved_at DESC LIMIT 1) AS budget,
        (SELECT coalesce(sum(sf.amount_reporting),0) FROM spend_fact sf WHERE sf.envelope_id = e.id AND sf.period_date BETWEEN ${pStart} AND ${pEnd}) AS actual,
        (SELECT coalesce(sum(pf.value_reporting),0) FROM projection_fact pf WHERE pf.envelope_id = e.id AND pf.metric='spend'
           AND pf.period_date BETWEEN ${pStart} AND ${pEnd}
           AND pf.source_run_id = (SELECT source_run_id FROM projection_fact x WHERE x.envelope_id = e.id ORDER BY loaded_at DESC LIMIT 1)) AS projected
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

  const where = compileFilter(q.filter ?? { logic: "and", children: [] }, b, ctx);

  // group-by dimension codes as lateral joins
  const dimJoins = q.groupBy
    .map(
      (k, i) => `
    LEFT JOIN LATERAL (
      SELECT dv.code, dv.label FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id JOIN dimension d ON d.id = ed.dimension_id
      WHERE ed.envelope_id = e.id AND d.key = ${b.p(k)} LIMIT 1) g${i} ON TRUE`,
    )
    .join("");
  const dimSelect = q.groupBy.map((k, i) => `g${i}.code AS dim_${sanitize(k)}, g${i}.label AS lbl_${sanitize(k)}`).join(", ");
  const measureAgg = q.measures
    .map((mk) => {
      if (mk === "pace_index" || mk === "variance_pct" || mk === "projected_close_pct" || mk === "spend_to_date_pct") {
        // ratio measures are recomputed from sums, never averaged
        return `CASE WHEN sum(m.budget) > 0 THEN ${ratioExpr(mk, elapsedFrac)} ELSE NULL END AS ${mk}`;
      }
      return `sum(m.${mk}) AS ${mk}`;
    })
    .join(", ");

  const groupSql = q.groupBy.length
    ? `SELECT ${dimSelect}, ${measureAgg}, count(*) AS leaf_count,
         sum(CASE WHEN e.status='PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id ${dimJoins}
       WHERE ${where}
       GROUP BY ${q.groupBy.map((_, i) => `g${i}.code, g${i}.label`).join(", ")}`
    : `SELECT e.id AS envelope_id, e.name, e.status::text AS status, e.parent_id, e.dimension_values, ${q.measures.map((mk) => `m.${mk}`).join(", ")}
         ${q.targets.map((mk) => `, m.kpi_${sanitize(mk)}`).join("")},
         (SELECT count(*) FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED')) AS open_alerts,
         (SELECT count(*) FROM thread t WHERE t.anchor_type='envelope' AND t.anchor_id = e.id AND t.status='open') AS open_threads
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id
       WHERE ${where}`;

  const order = q.sort.length
    ? `ORDER BY ${q.sort.map((s) => `${sanitizeSortKey(s.key)} ${s.dir.toUpperCase()} NULLS LAST`).join(", ")}`
    : q.groupBy.length
      ? ""
      : "ORDER BY e.name";
  const offset = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : 0;
  const sql = `WITH ${measuresCte} ${groupSql} ${order} LIMIT ${b.p(q.limit + 1)} OFFSET ${b.p(offset)}`;
  return { sql, values: b.values };
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

/** Derived metric over facts for one envelope alias e. Reads metric_definition at planning time (cached). */
export function derivedMetricSql(metricKey: string, b: SqlBuilder, pStart: string, pEnd: string): string {
  const def = metricRegistry.get(metricKey); // loaded by the planner service from metric_definition
  if (!def) throw new Error(`unknown metric ${metricKey}`);
  const src = (ref: string) =>
    ref === "spend"
      ? `(SELECT coalesce(sum(amount_reporting),0) FROM spend_fact WHERE envelope_id = e.id AND period_date BETWEEN ${pStart} AND ${pEnd})`
      : `(SELECT coalesce(sum(value),0) FROM kpi_fact WHERE envelope_id = e.id AND metric = ${b.p(ref.replace("kpi:", ""))} AND period_date BETWEEN ${pStart} AND ${pEnd})`;
  return def.denominator ? `${src(def.numerator)} / NULLIF(${src(def.denominator)},0)` : src(def.numerator);
}

export const metricRegistry = new Map<string, { numerator: string; denominator: string | null }>();
const sanitizeSortKey = (k: string) => k.replace(/[^a-z0-9_.]/gi, "");
