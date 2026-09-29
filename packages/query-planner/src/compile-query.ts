import { Buffer } from "node:buffer";
import { Decimal } from "decimal.js";
import { COMPARE_MEASURES, DomainError, isPredicate, type FilterGroupT, type QueryRequest, type ScopeFilter } from "@budget/domain";
import { SqlBuilder } from "./sql-builder.js";
import { compileFilter, filterMetrics, sanitize, type CompileCtx } from "./compile-filter.js";

/**
 * A metric from `metric_definition` (plan §4.8). numerator / denominator are `spend`, `budget` or
 * `kpi:<fact metric>`; multiplier scales the ratio (CPM = spend / impressions × 1000).
 */
export interface MetricDef {
  numerator: string;
  denominator: string | null;
  multiplier?: string | undefined;
}

/** A current filter-scoped target (spec §10). Applies where no envelope-scoped target exists; first match wins. */
export interface FilterTarget {
  metricKey: string;
  value: string;
  scope: ScopeFilter;
}

export interface CompileOptions {
  /** The org's metric library; defaults to the process-wide `metricRegistry`. */
  metrics?: ReadonlyMap<string, MetricDef> | undefined;
  /** Filter-scoped targets for the requested metrics, most specific first. */
  filterTargets?: readonly FilterTarget[] | undefined;
  /**
   * false when the workspace has no projection facts: `projected` is then 0 without reading
   * projection_fact (ADR-030). Omitted means unknown, and the SQL reads them.
   */
  hasProjections?: boolean | undefined;
  /** Grouped rows also carry `start_date` / `end_date`: the earliest start and latest end of the group's envelopes (the timeline's group bars, T-037). */
  groupDates?: boolean | undefined;
  /**
   * Internal (not part of the FilterGroup AST): only these envelopes. The roll-up refresh resolves a
   * node's envelopes first and passes them here, so Postgres plans from a known set (ADR-038).
   */
  envelopeIds?: readonly string[] | undefined;
}

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

export const RATIO = new Set(["pace_index", "variance_pct", "projected_close_pct", "spend_to_date_pct"]);
/** Measures that read projected spend. */
const PROJECTION = new Set(["projected", "variance_abs", "variance_pct", "projected_close_pct"]);

/** The measures derived from projected spend, per envelope; m2 and a flat page's tail share them. */
function projectionDerived(projected: string, budget: string): Record<"variance_abs" | "variance_pct" | "projected_close_pct", string> {
  return {
    variance_abs: `(${projected} - ${budget})`,
    variance_pct: `CASE WHEN ${budget} > 0 THEN (${projected} - ${budget}) / ${budget} ELSE NULL END`,
    projected_close_pct: `CASE WHEN ${budget} > 0 THEN ${projected} / ${budget} ELSE NULL END`,
  };
}

/** Whether a filter reads any of these measures. */
function filterReads(g: FilterGroupT, keys: ReadonlySet<string>): boolean {
  return g.children.some((c) => (isPredicate(c) ? c.field.kind === "measure" && keys.has(c.field.key) : filterReads(c, keys)));
}

interface Base {
  b: SqlBuilder;
  measuresCte: string;
  where: string;
  measureAgg: string;
  measures: string[];
  /** Per requested metric: its KPI over a group, Σnumerator / Σdenominator (never an average of ratios). */
  kpiAgg: string;
  targetSql: (metric: string) => string;
  /** `LEFT JOIN LATERAL … p ON TRUE`: p.projected of the envelope `envelopeId` refers to; "" without projections. */
  projectionJoin: (envelopeId: string) => string;
  /** ADR-059: rows hold their unsplit amounts (`unallocated`). */
  held: boolean;
  /** The group and totals `leaf_count` expression. */
  leafCount: string;
}

function compileBase(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions): Base {
  if (q.grain !== "total") throw new DomainError("VALIDATION", `grain ${q.grain} is not supported by the Postgres planner`);
  if (q.templateId !== undefined) throw new DomainError("VALIDATION", "templateId tree order is not supported by the Postgres planner");
  const held = q.unallocated === true;
  if (held && q.subtree === true) throw new DomainError("VALIDATION", "unallocated rows cannot be combined with subtree");
  const b = new SqlBuilder();
  const ctx: CompileCtx = { workspaceId: q.workspaceId, periodStart: period.start, periodEnd: period.end, today };
  const asOf = q.asOf ? `${b.p(q.asOf)}::timestamptz` : "now()";
  const ws = b.p(q.workspaceId);
  const pStart = `${b.p(period.start)}::date`,
    pEnd = `${b.p(period.end)}::date`;
  const elapsedFrac = `LEAST(1, GREATEST(0, (${b.p(today)}::date - ${pStart}::date + 1)::numeric / NULLIF((${pEnd}::date - ${pStart}::date + 1),0)))`;

  // KPI columns requested via targets[] or read by the filter. Each carries its numerator and
  // denominator per envelope (num_<m>, den_<m>) so every roll-up level divides sums: CPA of a group
  // is Σspend / Σconversions. KPIs are derived from facts at query time, never stored.
  const filter = q.filter ?? { logic: "and" as const, children: [] };
  const kpiMetrics = [...new Set([...q.targets, ...filterMetrics(filter)])];
  const defs = opts.metrics ?? metricRegistry;
  const budgetOf = (alias: string) => `(SELECT v.amount_reporting FROM envelope_version v WHERE v.envelope_id = ${alias}.id AND v.amount_type = 'BUDGET'
           AND v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= ${asOf}
           ORDER BY v.approved_at DESC LIMIT 1)`;
  const budgetSql = budgetOf("e");
  // The share of an envelope's days that fall in the period (its budget's share, below).
  const shareOf = (alias: string) => `(LEAST(${alias}.end_date, ${pEnd}) - GREATEST(${alias}.start_date, ${pStart}) + 1)::numeric / NULLIF(${alias}.end_date - ${alias}.start_date + 1, 0)`;
  // Phase E (H-004): the budget to compare with, per envelope: a snapshot's frozen amount, or the
  // version approved at another instant (the same rule as budgetSql). Change = now − then.
  const compare = q.compareTo;
  if (compare === undefined && (q.measures.some((mk) => COMPARE_MEASURES.has(mk)) || filterReads(filter, COMPARE_MEASURES) || q.sort.some((s) => COMPARE_MEASURES.has(s.key.replace(/^[em]\./, ""))))) {
    throw new DomainError("VALIDATION", "budget_baseline and the change measures need compareTo (a snapshot or an instant)");
  }
  const baselineOf = (alias: string) =>
    compare === undefined
      ? "NULL::numeric"
      : "baselineId" in compare
        ? `(SELECT br.amount_reporting FROM budget_baseline_row br WHERE br.baseline_id = ${b.p(compare.baselineId)}::uuid AND br.workspace_id = ${ws}::uuid AND br.envelope_id = ${alias}.id)`
        : `(SELECT v.amount_reporting FROM envelope_version v WHERE v.envelope_id = ${alias}.id AND v.amount_type = 'BUDGET'
           AND v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= ${b.p(compare.asOf)}::timestamptz
           ORDER BY v.approved_at DESC LIMIT 1)`;
  const baselineSql = baselineOf("e");
  // Only a comparing query carries the change columns (the check above refuses them otherwise).
  const compareCols =
    compare === undefined
      ? ""
      : `,
        (coalesce(budget, 0) - coalesce(budget_baseline, 0)) AS budget_change_abs,
        CASE WHEN budget_baseline > 0 THEN (coalesce(budget, 0) - budget_baseline) / budget_baseline ELSE NULL END AS budget_change_pct`;
  const requested = new Set(q.targets);
  let kpiCols = "";
  let kpiDerived = "";
  let kpiAgg = "";
  const kpiNames: string[] = [];
  for (const mk of kpiMetrics) {
    const def = defs.get(mk);
    if (!def) throw new DomainError("VALIDATION", `unknown metric ${mk}`);
    const s = sanitize(mk);
    const mult = def.multiplier === undefined || new Decimal(def.multiplier).equals(1) ? "" : ` * ${b.p(def.multiplier)}::numeric`;
    const num = def.numerator === "budget" ? budgetSql : factSql(mk, def.numerator, b, pStart, pEnd, ws, period);
    if (def.denominator) {
      const den = def.denominator === "budget" ? budgetSql : factSql(mk, def.denominator, b, pStart, pEnd, ws, period);
      kpiCols += `, ${num} AS num_${s}, ${den} AS den_${s}`;
      kpiNames.push(`num_${s}`, `den_${s}`);
      kpiDerived += `, (num_${s}${mult} / NULLIF(den_${s},0)) AS kpi_${s}`;
      if (requested.has(mk)) kpiAgg += `, (sum(m.num_${s})${mult} / NULLIF(sum(m.den_${s}),0)) AS kpi_${s}`;
    } else {
      kpiCols += `, ${num} AS num_${s}`;
      kpiNames.push(`num_${s}`);
      kpiDerived += `, (num_${s}${mult}) AS kpi_${s}`;
      if (requested.has(mk)) kpiAgg += `, (sum(m.num_${s})${mult}) AS kpi_${s}`;
    }
  }

  // Projected spend: the envelope's latest projection run (picked over all dates, so a newer run that
  // projects only outside the period still wins and projects 0), summed over the period. One lateral
  // per envelope reads its facts once and groups them by run (ADR-030); a scalar subquery here was
  // copied into every expression that reads `projected`. Nothing reads `p` unless a projection
  // measure does, and Postgres then drops the join (the lateral returns one row). The EXISTS is
  // uncorrelated, so it runs once and a workspace without projection facts skips the per-envelope
  // scans; with `hasProjections: false` the lateral is not emitted at all.
  const projectionJoin = (envelopeId: string): string =>
    opts.hasProjections === false
      ? ""
      : ` LEFT JOIN LATERAL (
        SELECT (array_agg(r.projected ORDER BY r.loaded_at DESC))[1] AS projected
        FROM (SELECT sum(x.value_reporting) FILTER (WHERE x.period_date BETWEEN ${pStart} AND ${pEnd}) AS projected, max(x.loaded_at) AS loaded_at
              FROM projection_fact x
              WHERE x.workspace_id = ${ws}::uuid AND x.envelope_id = ${envelopeId} AND x.metric = 'spend'
                AND (SELECT EXISTS (SELECT 1 FROM projection_fact y WHERE y.workspace_id = ${ws}::uuid AND y.metric = 'spend'))
              GROUP BY x.source_run_id) r
      ) p ON TRUE`;

  // Budget as of a timestamp is the latest version approved by then. Versions approved earlier are
  // SUPERSEDED now (spec §7.3), so status alone cannot select them.
  const derived = projectionDerived("projected", "budget");
  const onlyIds = opts.envelopeIds === undefined ? "" : ` AND e.id = ANY(${b.p([...opts.envelopeIds])}::uuid[])`;
  // Budget structure (ADR-050): each envelope's spend and projections are its own plus everything
  // under it, so a parent reads against its own amount. `WITH RECURSIVE` walks the parent links.
  const subtree = q.subtree === true;
  const subtreeCte = !subtree
    ? ""
    : `,
    sub AS (
      SELECT o.envelope_id AS root, o.envelope_id AS node FROM m_own o
      UNION ALL
      SELECT s.root, c.id FROM sub s JOIN envelope c ON c.parent_id = s.node AND c.status <> 'ARCHIVED'
    ),
    m AS (
      SELECT o.envelope_id, o.budget,${compare === undefined ? "" : " o.budget_baseline,"} o.period_share, coalesce(x.actual, 0) AS actual, coalesce(x.projected, 0) AS projected${kpiNames.map((n) => `, o.${n}`).join("")}
      FROM m_own o
      LEFT JOIN (SELECT s.root, sum(d.actual) AS actual, sum(d.projected) AS projected FROM sub s JOIN m_own d ON d.envelope_id = s.node GROUP BY s.root) x ON x.root = o.envelope_id
    )`;
  // Unallocated (ADR-059): each envelope holds its amount less its live children's in the period, so
  // Σ over any set of rows telescopes to the budgets at its top. Children are read from `envelope`,
  // not from m_own, so a roll-up refresh scoped to `envelopeIds` still subtracts every child.
  const minus = (own: string, kids: string) => `CASE WHEN ${own} IS NULL AND ${kids} IS NULL THEN NULL ELSE coalesce(${own}, 0) - coalesce(${kids}, 0) END`;
  const heldCte = !held
    ? ""
    : `,
    kids AS (
      SELECT c.parent_id, sum(${budgetOf("c")}) AS budget, sum(${budgetOf("c")} * ${shareOf("c")}) AS budget_in_period,${compare === undefined ? "" : ` sum(${baselineOf("c")}) AS budget_baseline,`} count(*) AS n
      FROM envelope c
      WHERE c.workspace_id = ${ws}::uuid AND c.parent_id IS NOT NULL AND c.status <> 'ARCHIVED'
        AND c.start_date <= ${pEnd} AND c.end_date >= ${pStart}${opts.envelopeIds === undefined ? "" : ` AND c.parent_id = ANY(${b.p([...opts.envelopeIds])}::uuid[])`}
      GROUP BY c.parent_id
    ),
    m AS (
      SELECT o.envelope_id, ${minus("o.budget", "k.budget")} AS budget,${compare === undefined ? "" : ` ${minus("o.budget_baseline", "k.budget_baseline")} AS budget_baseline,`}
        o.period_share, ${minus("o.budget * o.period_share", "k.budget_in_period")} AS budget_in_period,
        o.actual, o.projected${kpiNames.map((n) => `, o.${n}`).join("")}, coalesce(k.n, 0) AS child_count
      FROM m_own o LEFT JOIN kids k ON k.parent_id = o.envelope_id
    )`;
  const measuresCte = `${subtree ? "RECURSIVE " : ""}
    ${subtree || held ? "m_own" : "m"} AS (
      SELECT e.id AS envelope_id,
        ${budgetSql} AS budget,${compare === undefined ? "" : `
        ${baselineSql} AS budget_baseline,`}
        ${shareOf("e")} AS period_share,
        ${spendSql(b, period, ws)} AS actual,
        ${opts.hasProjections === false ? "0::numeric" : "coalesce(p.projected, 0)"} AS projected
        ${kpiCols}
      FROM envelope e${projectionJoin("e.id")}
      WHERE e.workspace_id = ${ws}::uuid
        AND e.start_date <= ${pEnd} AND e.end_date >= ${pStart}${subtree ? "" : onlyIds}
    )${subtreeCte}${heldCte},
    m1 AS (
      SELECT *${held ? "" : ", budget * period_share AS budget_in_period"} FROM m
    ),
    m2 AS (
      SELECT *, (budget - actual) AS remaining,
        ${derived.variance_abs} AS variance_abs,
        ${derived.variance_pct} AS variance_pct,
        CASE WHEN budget > 0 THEN actual / budget ELSE NULL END AS spend_to_date_pct,
        -- Pace: the period's spend against the budget's share of the period, over the share of the period gone.
        CASE WHEN budget_in_period > 0 AND ${elapsedFrac} > 0 THEN (actual / budget_in_period) / ${elapsedFrac} ELSE NULL END AS pace_index,
        ${derived.projected_close_pct} AS projected_close_pct${compareCols}
        ${kpiDerived}
      FROM m1
    )`;

  // Target of one envelope row: envelope-scoped via effective_target() (walks up parents), else the
  // first filter-scoped target whose scope matches the envelope's dimensions (spec §10).
  const targetSql = (metric: string): string => {
    const scoped = (opts.filterTargets ?? []).filter((t) => t.metricKey === metric);
    const own = `(SELECT et.value FROM effective_target(e.id, ${b.p(metric)}::text) et)`;
    if (scoped.length === 0) return own;
    const arms = scoped.map((t) => `WHEN ${"children" in t.scope ? compileFilter(t.scope as FilterGroupT, b, ctx) : "TRUE"} THEN ${b.p(t.value)}::numeric`);
    return `COALESCE(${own}, CASE ${arms.join(" ")} END)`;
  };
  ctx.targetSql = targetSql;

  const own = onlyIds ? `(${compileFilter(filter, b, ctx)})${onlyIds}` : compileFilter(filter, b, ctx);
  // A parent that has split all of its amount and has no spend of its own holds nothing: no row.
  const where = !held
    ? own
    : `(${own}) AND NOT (m.child_count > 0 AND coalesce(m.budget, 0) = 0${compare === undefined ? "" : " AND coalesce(m.budget_baseline, 0) = 0"} AND m.actual = 0 AND m.projected = 0)`;
  const leafCount = held ? "sum(CASE WHEN m.child_count = 0 THEN 1 ELSE 0 END)" : "count(*)";
  const measures = [...new Set(q.measures)];
  const measureAgg = measures
    .map((mk) => {
      // A group's change % is its total change over its total baseline, never an average of %.
      if (mk === "budget_change_pct") return `CASE WHEN sum(m.budget_baseline) > 0 THEN sum(m.budget_change_abs) / sum(m.budget_baseline) ELSE NULL END AS ${mk}`;
      if (RATIO.has(mk)) {
        // ratio measures are recomputed from sums, never averaged
        return `CASE WHEN sum(m.budget) > 0 THEN ${ratioExpr(mk, elapsedFrac)} ELSE NULL END AS ${mk}`;
      }
      return `sum(m.${mk}) AS ${mk}`;
    })
    .join(", ");
  return { b, measuresCte, where, measureAgg, measures, kpiAgg, targetSql, projectionJoin, held, leafCount };
}

export function compileQuery(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions = {}): CompiledQuery {
  const { b, measuresCte, where, measureAgg, measures, kpiAgg, targetSql, projectionJoin, held, leafCount } = compileBase(q, period, today, opts);
  const subtree = q.subtree === true;
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
  const targetMetrics = q.targets.length > 1 ? [...new Set(q.targets)] : q.targets;
  const targetKeys = targetMetrics.map(sanitize);
  // Flat rows: actual, target and actual / target per metric; one lateral per target so it is
  // resolved once. Built only for flat rows: an unreferenced $n makes Postgres reject the statement.
  let kpiSelect = "";
  let targetJoins = "";
  if (!grouped) {
    targetMetrics.forEach((mk, i) => {
      const s = targetKeys[i] as string;
      kpiSelect += `, m.kpi_${s}, t${i}.v AS tgt_${s}, m.kpi_${s} / NULLIF(t${i}.v,0) AS vs_${s}`;
      targetJoins += ` LEFT JOIN LATERAL (SELECT ${targetSql(mk)} AS v) t${i} ON TRUE`;
    });
  }
  const columns = new Set<string>(
    grouped
      ? [...groupKeys.flatMap((k) => [`dim_${k}`, `lbl_${k}`]), ...measures, ...targetKeys.map((s) => `kpi_${s}`), "leaf_count", "pending_count"]
      : ["envelope_id", "name", "status", "parent_id", ...(subtree || held ? ["child_count"] : []), ...measures, ...targetKeys.flatMap((s) => [`kpi_${s}`, `tgt_${s}`, `vs_${s}`]), "open_alerts", "open_threads"],
  );
  const orderKeys = resolveOrder(q, columns, grouped ? groupKeys.map((k) => `dim_${k}`) : ["envelope_id"], grouped ? [] : ["name"]);
  const after = q.cursor === undefined ? "TRUE" : keysetAfter(orderKeys, decodeCursor(q.cursor, orderKeys.length), b);
  const order = orderKeys.map((o) => `q.${o.col} ${o.dir.toUpperCase()} NULLS LAST`).join(", ");
  const limit = b.p(q.limit + 1);

  // A flat page whose order and filter do not read projected spend gets it after the LIMIT, for
  // its own rows only (ADR-030): a lateral over every envelope would cost more than the page.
  const tail =
    !grouped &&
    !subtree && !held && opts.hasProjections !== false && measures.some((mk) => PROJECTION.has(mk)) && !orderKeys.some((o) => PROJECTION.has(o.col)) && !filterReads(q.filter ?? { logic: "and", children: [] }, PROJECTION);
  const flatMeasures = tail ? measures.filter((mk) => !PROJECTION.has(mk)) : measures;

  const groupSql = grouped
    ? `SELECT ${dimSelect}, ${measureAgg}${kpiAgg}, ${leafCount} AS leaf_count,${opts.groupDates ? " min(e.start_date)::text AS start_date, max(e.end_date)::text AS end_date," : ""}
         sum(CASE WHEN e.status='PENDING' THEN 1 ELSE 0 END) AS pending_count
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id ${dimJoins}
       WHERE ${where}
       GROUP BY ${q.groupBy.map((_, i) => `g${i}.code, g${i}.label`).join(", ")}`
    : `SELECT e.id AS envelope_id, coalesce(e.display_name, e.name) AS name, CASE WHEN e.ended_at IS NOT NULL THEN 'ENDED' ELSE e.status::text END AS status, e.parent_id, coalesce(e.draft_version_id, e.current_version_id) AS head_version_id, e.dimension_values${subtree ? `, (SELECT count(*) FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED') AS child_count` : held ? ", m.child_count" : ""}${flatMeasures.map((mk) => `, m.${mk}`).join("")}${tail ? ", m.budget AS tail_budget" : ""}
         ${kpiSelect},
         (SELECT count(*) FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED')) AS open_alerts,
         (SELECT count(*) FROM thread t WHERE t.anchor_type='envelope' AND t.anchor_id = e.id AND t.status='open') AS open_threads
       FROM envelope e JOIN m2 m ON m.envelope_id = e.id${targetJoins}
       WHERE ${where}`;

  const page = `SELECT * FROM (${groupSql}) q WHERE ${after} ORDER BY ${order} LIMIT ${limit}`;
  if (!tail) return { sql: `WITH ${measuresCte} ${page}`, values: b.values, orderKeys };
  const derived = projectionDerived("coalesce(p.projected, 0)", "q.tail_budget");
  const measureCol = (mk: string) => (!PROJECTION.has(mk) ? `q.${mk}` : `${mk === "projected" ? "coalesce(p.projected, 0)" : derived[mk as keyof typeof derived]} AS ${mk}`);
  // Same columns in the same order as a page without the tail.
  const cols = [
    ...["envelope_id", "name", "status", "parent_id", "head_version_id", "dimension_values"].map((c) => `q.${c}`),
    ...measures.map(measureCol),
    ...targetKeys.flatMap((s) => [`q.kpi_${s}`, `q.tgt_${s}`, `q.vs_${s}`]),
    "q.open_alerts",
    "q.open_threads",
  ];
  const sql = `WITH ${measuresCte} SELECT ${cols.join(", ")}
    FROM (${page}) q${projectionJoin("q.envelope_id")}
    ORDER BY ${order}`;
  return { sql, values: b.values, orderKeys };
}

/** One row of totals over every envelope the filter selects; same measure semantics as a group. */
export function compileTotals(q: QueryRequest, period: { start: string; end: string }, today: string, opts: CompileOptions = {}): CompiledQuery {
  const { b, measuresCte, where, measureAgg, kpiAgg, leafCount } = compileBase(q, period, today, opts);
  const sql = `WITH ${measuresCte} SELECT ${measureAgg}${kpiAgg}, ${leafCount} AS leaf_count FROM envelope e JOIN m2 m ON m.envelope_id = e.id WHERE ${where}`;
  return { sql, values: b.values, orderKeys: [] };
}

/**
 * Keyset order: requested sort keys, then a unique tie-break. Offsets drift when rows are inserted
 * between pages; a keyset cursor does not.
 */
export function resolveOrder(q: QueryRequest, columns: Set<string>, tieBreak: string[], defaultSort: string[]): OrderKey[] {
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
const NUMERIC_COLS = new Set(["budget", "budget_in_period", "budget_baseline", "budget_change_abs", "budget_change_pct", "actual", "projected", "remaining", "variance_abs", "variance_pct", "pace_index", "projected_close_pct", "spend_to_date_pct", "leaf_count", "pending_count", "child_count", "open_alerts", "open_threads"]);
const castFor = (col: string) => (UUID_COLS.has(col) ? "uuid" : NUMERIC_COLS.has(col) || /^(kpi|tgt|vs)_/.test(col) ? "numeric" : "text");

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
      return `(sum(m.actual)/NULLIF(sum(m.budget_in_period),0)) / NULLIF(${elapsedFrac},0)`;
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

/** One source of a metric over facts for envelope alias e. `ws` is the workspace placeholder so the fact indexes apply. */
function factSql(metricKey: string, ref: string, b: SqlBuilder, pStart: string, pEnd: string, ws: string, period?: { start: string; end: string }): string {
  if (ref === "spend") {
    if (period) return spendSql(b, period, ws);
    return `(SELECT coalesce(sum(amount_reporting),0) FROM spend_fact WHERE workspace_id = ${ws}::uuid AND envelope_id = e.id AND period_date BETWEEN ${pStart} AND ${pEnd})`;
  }
  if (!ref.startsWith("kpi:")) throw new DomainError("VALIDATION", `metric ${metricKey} references unknown source ${ref}`);
  return `(SELECT coalesce(sum(value),0) FROM kpi_fact WHERE workspace_id = ${ws}::uuid AND envelope_id = e.id AND metric = ${b.p(ref.slice(4))}::text AND period_date BETWEEN ${pStart} AND ${pEnd})`;
}

/** Derived metric for one envelope alias e (a single ratio; roll-ups use compileQuery's num/den columns). */
export function derivedMetricSql(metricKey: string, b: SqlBuilder, pStart: string, pEnd: string, ws: string, metrics: ReadonlyMap<string, MetricDef> = metricRegistry): string {
  const def = metrics.get(metricKey);
  if (!def) throw new DomainError("VALIDATION", `unknown metric ${metricKey}`);
  if (def.numerator === "budget" || def.denominator === "budget") throw new DomainError("VALIDATION", `metric ${metricKey} needs the planner's budget column; use compileQuery`);
  const mult = def.multiplier === undefined || new Decimal(def.multiplier).equals(1) ? "" : ` * ${b.p(def.multiplier)}::numeric`;
  const num = factSql(metricKey, def.numerator, b, pStart, pEnd, ws);
  return def.denominator ? `${num}${mult} / NULLIF(${factSql(metricKey, def.denominator, b, pStart, pEnd, ws)},0)` : `${num}${mult}`;
}

/**
 * The months of [start, end] split into whole months ([fullStart, fullEnd) as first-of-month dates)
 * and the partial days at either edge. Pure date arithmetic on ISO strings.
 */
export function monthSplit(start: string, end: string): { full: [string, string] | null; edges: Array<[string, string]> } {
  const first = (d: string) => `${d.slice(0, 7)}-01`;
  const addMonth = (m: string) => {
    const [y, mo] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
    return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  };
  const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const fullStart = start === first(start) ? start : addMonth(first(start));
  const fullEnd = first(addDay(end, 1)); // exclusive: the month after the last whole month
  if (fullStart >= fullEnd) return { full: null, edges: [[start, end]] };
  const edges: Array<[string, string]> = [];
  if (start < fullStart) edges.push([start, addDay(fullStart, -1)]);
  if (addDay(end, 1) > fullEnd) edges.push([fullEnd, end]);
  return { full: [fullStart, fullEnd], edges };
}

/**
 * Spend of envelope alias e over the period (ADR-037): whole months from spend_month, the partial
 * months at the edges from spend_fact. Same total as summing spend_fact over the period.
 */
function spendSql(b: SqlBuilder, period: { start: string; end: string }, ws: string): string {
  const split = monthSplit(period.start, period.end);
  const parts = split.edges.map(
    ([from, to]) => `(SELECT coalesce(sum(sf.amount_reporting),0) FROM spend_fact sf WHERE sf.workspace_id = ${ws}::uuid AND sf.envelope_id = e.id AND sf.period_date BETWEEN ${b.p(from)}::date AND ${b.p(to)}::date)`,
  );
  if (split.full) parts.unshift(`(SELECT coalesce(sum(sm.amount_reporting),0) FROM spend_month sm WHERE sm.workspace_id = ${ws}::uuid AND sm.envelope_id = e.id AND sm.month >= ${b.p(split.full[0])}::date AND sm.month < ${b.p(split.full[1])}::date)`);
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" + ")})`;
}

/** Process-wide metric library for callers that do not pass `CompileOptions.metrics` (tests, benches). */
export const metricRegistry = new Map<string, MetricDef>();
