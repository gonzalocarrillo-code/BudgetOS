import { Buffer } from "node:buffer";
import { DomainError, isPredicate, type FilterGroupT, type QueryRequest } from "@budget/domain";
import { compileFilter, sanitize, type CompileCtx } from "./compile-filter.js";
import { RATIO, keysetAfter, monthSplit, ratioExpr, resolveOrder, type CompiledQuery, type CompileOptions } from "./compile-query.js";
import { SqlBuilder } from "./sql-builder.js";

/**
 * The set-based planner for heavy reads (spec §6.2 routing rule, ADR-042): grouped rows and totals
 * computed as sets — the selected envelopes, then each one's approved budget, spend and projected
 * spend once, joined, then grouped — instead of one correlated subquery per envelope. The same
 * answer as `compileQuery` / `compileTotals` (same columns, same order keys, same cursor), for the
 * shapes it supports: grouped or total queries whose filter reads dimensions and envelope
 * attributes (not measures or targets), with no KPI target columns. Postgres runs it here; the
 * BigQuery dialect (`compile-aggregate.bq.ts`) runs the same shape on the warehouse replica.
 */

const SUPPORTED_MEASURES = new Set(["budget", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct"]);

function filterIsPlain(g: FilterGroupT): boolean {
  return g.children.every((c) => (isPredicate(c) ? c.field.kind === "dimension" || c.field.kind === "attr" : filterIsPlain(c)));
}

/** Whether the set-based planner answers this query (else the per-envelope planner does). */
export function aggregateSupported(q: QueryRequest, opts: CompileOptions = {}): boolean {
  if (q.grain !== "total" || q.templateId !== undefined || q.targets.length > 0 || opts.groupDates || opts.envelopeIds !== undefined) return false;
  if (!q.measures.every((m) => SUPPORTED_MEASURES.has(m))) return false;
  return filterIsPlain(q.filter ?? { logic: "and", children: [] });
}

interface Base {
  b: SqlBuilder;
  ctes: string;
  measureAgg: string;
  measures: string[];
}

function compileBase(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions, dims: string[]): Base {
  if (!aggregateSupported(q, opts)) throw new DomainError("VALIDATION", "query shape is not supported by the set-based planner");
  const b = new SqlBuilder();
  const ctx: CompileCtx = { workspaceId: q.workspaceId, periodStart: period.start, periodEnd: period.end, today };
  const asOf = q.asOf ? `${b.p(q.asOf)}::timestamptz` : "now()";
  const ws = `${b.p(q.workspaceId)}::uuid`;
  const pStart = `${b.p(period.start)}::date`;
  const pEnd = `${b.p(period.end)}::date`;
  const elapsedFrac = `LEAST(1, GREATEST(0, (${b.p(today)}::date - ${pStart} + 1)::numeric / NULLIF((${pEnd} - ${pStart} + 1),0)))`;
  const where = compileFilter(q.filter ?? { logic: "and", children: [] }, b, ctx);

  // Spend: whole months from spend_month, partial months at the edges from spend_fact (ADR-037).
  const split = monthSplit(period.start, period.end);
  const spendParts = [
    ...(split.full ? [`SELECT sm.envelope_id, sm.amount_reporting AS amount FROM spend_month sm JOIN sel ON sel.id = sm.envelope_id WHERE sm.workspace_id = ${ws} AND sm.month >= ${b.p(split.full[0])}::date AND sm.month < ${b.p(split.full[1])}::date`] : []),
    ...split.edges.map(([from, to]) => `SELECT sf.envelope_id, sf.amount_reporting AS amount FROM spend_fact sf JOIN sel ON sel.id = sf.envelope_id WHERE sf.workspace_id = ${ws} AND sf.period_date BETWEEN ${b.p(from)}::date AND ${b.p(to)}::date`),
  ];
  const withProjections = opts.hasProjections !== false;
  const dimCtes = dims
    .map(
      (k, i) => `,
    d${i} AS (
      SELECT DISTINCT ON (ed.envelope_id) ed.envelope_id, dv.code, dv.label
      FROM envelope_dimension ed JOIN sel ON sel.id = ed.envelope_id JOIN dimension d ON d.id = ed.dimension_id JOIN dimension_value dv ON dv.id = ed.value_id
      WHERE d.key = ${b.p(k)}::text ORDER BY ed.envelope_id, dv.code
    )`,
    )
    .join("");
  const ctes = `
    sel AS (
      SELECT e.id, e.status FROM envelope e
      WHERE e.workspace_id = ${ws} AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart} AND (${where})
    ),
    bud AS (
      SELECT DISTINCT ON (v.envelope_id) v.envelope_id, v.amount_reporting AS budget
      FROM envelope_version v JOIN sel ON sel.id = v.envelope_id
      WHERE v.amount_type = 'BUDGET' AND v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= ${asOf}
      ORDER BY v.envelope_id, v.approved_at DESC
    ),
    act AS (
      SELECT envelope_id, sum(amount) AS actual FROM (${spendParts.join(" UNION ALL ")}) x GROUP BY envelope_id
    )${
      withProjections
        ? `,
    proj AS (
      SELECT DISTINCT ON (r.envelope_id) r.envelope_id, r.projected FROM (
        SELECT x.envelope_id, x.source_run_id, sum(x.value_reporting) FILTER (WHERE x.period_date BETWEEN ${pStart} AND ${pEnd}) AS projected, max(x.loaded_at) AS loaded_at
        FROM projection_fact x JOIN sel ON sel.id = x.envelope_id
        WHERE x.workspace_id = ${ws} AND x.metric = 'spend'
        GROUP BY x.envelope_id, x.source_run_id
      ) r ORDER BY r.envelope_id, r.loaded_at DESC
    )`
        : ""
    },
    m AS (
      SELECT sel.id AS envelope_id, sel.status::text AS status, b.budget, coalesce(a.actual, 0) AS actual, ${withProjections ? "coalesce(p.projected, 0)" : "0::numeric"} AS projected
      FROM sel LEFT JOIN bud b ON b.envelope_id = sel.id LEFT JOIN act a ON a.envelope_id = sel.id${withProjections ? " LEFT JOIN proj p ON p.envelope_id = sel.id" : ""}
    )${dimCtes}`;

  const measures = [...new Set(q.measures)];
  const measureAgg = measures
    .map((mk) => {
      if (RATIO.has(mk)) return `CASE WHEN sum(m.budget) > 0 THEN ${ratioExpr(mk, elapsedFrac)} ELSE NULL END AS ${mk}`;
      if (mk === "remaining") return `sum(m.budget - m.actual) AS remaining`;
      if (mk === "variance_abs") return `sum(m.projected - m.budget) AS variance_abs`;
      return `sum(m.${mk}) AS ${mk}`;
    })
    .join(", ");
  return { b, ctes, measureAgg, measures };
}

/** Grouped rows, as `compileQuery` returns them for a grouped query (columns, order keys, cursor). */
export function compileAggregate(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions = {}): CompiledQuery {
  if (q.groupBy.length === 0) throw new DomainError("VALIDATION", "compileAggregate needs groupBy; totals use compileAggregateTotals");
  const keys = q.groupBy.map(sanitize);
  if (new Set(keys).size !== keys.length) throw new DomainError("VALIDATION", "groupBy keys must be unique");
  const { b, ctes, measureAgg, measures } = compileBase(q, period, today, opts, q.groupBy);
  const columns = new Set<string>([...keys.flatMap((k) => [`dim_${k}`, `lbl_${k}`]), ...measures, "leaf_count", "pending_count"]);
  const orderKeys = resolveOrder(q, columns, keys.map((k) => `dim_${k}`), []);
  const after = q.cursor === undefined ? "TRUE" : keysetAfter(orderKeys, decodeCursor(q.cursor, orderKeys.length), b);
  const order = orderKeys.map((o) => `q.${o.col} ${o.dir.toUpperCase()} NULLS LAST`).join(", ");
  const joins = q.groupBy.map((_, i) => ` LEFT JOIN d${i} ON d${i}.envelope_id = m.envelope_id`).join("");
  const groupSql = `SELECT ${keys.map((k, i) => `d${i}.code AS dim_${k}, d${i}.label AS lbl_${k}`).join(", ")}, ${measureAgg}, count(*) AS leaf_count,
         sum(CASE WHEN m.status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM m${joins}
       GROUP BY ${q.groupBy.map((_, i) => `d${i}.code, d${i}.label`).join(", ")}`;
  const sql = `WITH ${ctes} SELECT * FROM (${groupSql}) q WHERE ${after} ORDER BY ${order} LIMIT ${b.p(q.limit + 1)}`;
  return { sql, values: b.values, orderKeys };
}

/** One row of totals over every envelope the filter selects, as `compileTotals` returns it. */
export function compileAggregateTotals(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions = {}): CompiledQuery {
  const { b, ctes, measureAgg } = compileBase(q, period, today, opts, []);
  return { sql: `WITH ${ctes} SELECT ${measureAgg}, count(*) AS leaf_count FROM m`, values: b.values, orderKeys: [] };
}

function decodeCursor(cursor: string, length: number): Array<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new DomainError("VALIDATION", "malformed cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== length || !parsed.every((v) => v === null || typeof v === "string")) throw new DomainError("VALIDATION", "cursor does not match this query's sort");
  return parsed as Array<string | null>;
}
