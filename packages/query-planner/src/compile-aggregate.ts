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
  // Every per-envelope input is a set of (envelope, value) rows folded by one GROUP BY, not joined:
  // under RLS Postgres estimates `sel` at a row or two, and a join of aggregated CTEs would re-run
  // the inner aggregate once per envelope.
  const cols = (status: string, budget: string, actual: string, projected: string, skip = -1, dimCols: string[] = []) =>
    [`${status} AS status`, `${budget} AS budget`, `${actual} AS actual`, `${projected} AS projected`, ...dims.flatMap((_, i) => (i === skip ? dimCols : [`NULL::text AS c${i}`, `NULL::text AS l${i}`]))].join(", ");
  const parts = [
    `SELECT sel.id AS envelope_id, ${cols("sel.status::text", "NULL::numeric", "NULL::numeric", "NULL::numeric")} FROM sel`,
    `SELECT v.envelope_id, ${cols("NULL::text", "v.budget", "NULL::numeric", "NULL::numeric")} FROM (
        SELECT DISTINCT ON (v.envelope_id) v.envelope_id, v.amount_reporting AS budget
        FROM envelope_version v JOIN sel ON sel.id = v.envelope_id
        WHERE v.amount_type = 'BUDGET' AND v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= ${asOf}
        ORDER BY v.envelope_id, v.approved_at DESC
      ) v`,
    ...spendParts.map((sp) => `SELECT s.envelope_id, ${cols("NULL::text", "NULL::numeric", "s.amount", "NULL::numeric")} FROM (${sp}) s`),
    ...(withProjections
      ? [
          `SELECT r.envelope_id, ${cols("NULL::text", "NULL::numeric", "NULL::numeric", "r.projected")} FROM (
        SELECT DISTINCT ON (r.envelope_id) r.envelope_id, r.projected FROM (
          SELECT x.envelope_id, x.source_run_id, sum(x.value_reporting) FILTER (WHERE x.period_date BETWEEN ${pStart} AND ${pEnd}) AS projected, max(x.loaded_at) AS loaded_at
          FROM projection_fact x JOIN sel ON sel.id = x.envelope_id
          WHERE x.workspace_id = ${ws} AND x.metric = 'spend'
          GROUP BY x.envelope_id, x.source_run_id
        ) r ORDER BY r.envelope_id, r.loaded_at DESC
      ) r`,
        ]
      : []),
    ...dims.map(
      // Looked up per selected envelope on the (envelope, dimension) key: a join here lets a low
      // estimate turn into a nested loop over every value row.
      (k, i) => `SELECT sel.id AS envelope_id, ${cols("NULL::text", "NULL::numeric", "NULL::numeric", "NULL::numeric", i, [`x.code AS c${i}`, `x.label AS l${i}`])}
        FROM sel CROSS JOIN LATERAL (
          SELECT dv.code, dv.label FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id
          WHERE ed.envelope_id = sel.id AND ed.dimension_id IN (SELECT d.id FROM dimension d WHERE d.key = ${b.p(k)}::text)
          ORDER BY dv.code LIMIT 1
        ) x`,
    ),
  ];
  // One row per envelope and dimension (first by code, as the per-envelope planner reads it).
  const dimAgg = dims.map((_, i) => `, max(u.c${i}) AS c${i}, max(u.l${i}) AS l${i}`).join("");
  const ctes = `
    sel AS (
      SELECT e.id, e.status FROM envelope e
      WHERE e.workspace_id = ${ws} AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart} AND (${where})
    ),
    m AS (
      SELECT u.envelope_id, max(u.status) AS status, sum(u.budget) AS budget, coalesce(sum(u.actual), 0) AS actual, coalesce(sum(u.projected), 0) AS projected${dimAgg}
      FROM (${parts.join("\n      UNION ALL ")}) u
      GROUP BY u.envelope_id
    )`;

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
  const groupSql = `SELECT ${keys.map((k, i) => `m.c${i} AS dim_${k}, m.l${i} AS lbl_${k}`).join(", ")}, ${measureAgg}, count(*) AS leaf_count,
         sum(CASE WHEN m.status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM m
       GROUP BY ${q.groupBy.map((_, i) => `m.c${i}, m.l${i}`).join(", ")}`;
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
