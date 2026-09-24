import type { Tx } from "./sql.js";

/** Fact loading and matching for the ingest pipeline (spec §14). Every statement runs in withTenant(). */

export interface SpendFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string; // yyyy-MM-dd
  currency: string;
  amount: string; // NUMERIC(18,2)
  amountReporting: string;
  fxRateId: string | null;
  rowHash: string;
}

export interface KpiFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string;
  metric: string;
  value: string; // NUMERIC(18,4)
  attributionModel: string | null;
  rowHash: string;
}

export interface ProjectionFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string;
  metric: string;
  value: string;
  valueReporting: string | null;
  formulaVersion: string;
  horizonEnd: string;
}

export interface FactLoad {
  workspaceId: string;
  sourceSystem: string;
  sourceRunId: string;
}

/**
 * Month partitions for every month in [from, to] (both yyyy-MM-dd). ensure_fact_partitions is
 * SECURITY DEFINER and takes at most 36 months per call (migration 20260924080000).
 */
export async function ensurePartitions(tx: Tx, from: string, to: string): Promise<void> {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const cursor = new Date(start);
  while (months >= 0) {
    const span = Math.min(months, 36);
    await tx.$executeRaw`SELECT ensure_fact_partitions(${cursor.toISOString().slice(0, 10)}::date, ${span}::int)`;
    cursor.setUTCMonth(cursor.getUTCMonth() + span + 1);
    months -= span + 1;
  }
}

const json = (rows: Array<{ dimensionValues: Record<string, string> }>) => rows.map((r) => JSON.stringify(r.dimensionValues));

/**
 * Upserts spend facts on (workspace_id, source_row_hash, period_date). A reloaded row keeps its
 * envelope and takes the new amount and run id, so the run's coverage counts it.
 */
export async function upsertSpendFacts(tx: Tx, load: FactLoad, rows: SpendFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO spend_fact (workspace_id, dimension_values, period_date, currency, amount, amount_reporting, fx_rate_id, source_system, source_run_id, source_row_hash)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, c, a::numeric, ar::numeric, fx::uuid, ${load.sourceSystem}, ${load.sourceRunId}::uuid, h
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.currency)}::text[],
                ${rows.map((r) => r.amount)}::text[], ${rows.map((r) => r.amountReporting)}::text[],
                ${rows.map((r) => r.fxRateId)}::text[], ${rows.map((r) => r.rowHash)}::text[]) AS t(d, p, c, a, ar, fx, h)
    ON CONFLICT (workspace_id, source_row_hash, period_date) DO UPDATE SET
      amount = EXCLUDED.amount, amount_reporting = EXCLUDED.amount_reporting, currency = EXCLUDED.currency,
      fx_rate_id = EXCLUDED.fx_rate_id, source_run_id = EXCLUDED.source_run_id, loaded_at = now()`;
}

export async function upsertKpiFacts(tx: Tx, load: FactLoad, rows: KpiFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO kpi_fact (workspace_id, dimension_values, period_date, metric, value, attribution_model, source_system, source_run_id, source_row_hash)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, m, v::numeric, am, ${load.sourceSystem}, ${load.sourceRunId}::uuid, h
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.metric)}::text[],
                ${rows.map((r) => r.value)}::text[], ${rows.map((r) => r.attributionModel)}::text[], ${rows.map((r) => r.rowHash)}::text[]) AS t(d, p, m, v, am, h)
    ON CONFLICT (workspace_id, source_row_hash, period_date) DO UPDATE SET
      value = EXCLUDED.value, attribution_model = EXCLUDED.attribution_model, source_run_id = EXCLUDED.source_run_id, loaded_at = now()`;
}

/** Projections are snapshots: each run inserts its own rows and the planner reads the latest run (spec §6.2). */
export async function insertProjectionFacts(tx: Tx, load: FactLoad, rows: ProjectionFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO projection_fact (workspace_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, m, v::numeric, vr::numeric, f, he::date, ${load.sourceSystem}, ${load.sourceRunId}::uuid
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.metric)}::text[],
                ${rows.map((r) => r.value)}::text[], ${rows.map((r) => r.valueReporting)}::text[], ${rows.map((r) => r.formulaVersion)}::text[],
                ${rows.map((r) => r.horizonEnd)}::text[]) AS t(d, p, m, v, vr, f, he)`;
}

/**
 * Spec §14 step 5, for each fact table: an unmatched fact of this run goes to the most specific
 * live envelope whose tuple is a subset of the fact's tuple and whose dates cover the fact's date.
 * Returns the envelopes that gained facts.
 */
export async function matchRunFacts(tx: Tx, workspaceId: string, runId: string): Promise<string[]> {
  const matched = new Set<string>();
  for (const table of ["spend_fact", "kpi_fact", "projection_fact"] as const) {
    const rows = await tx.$queryRawUnsafe<Array<{ envelope_id: string }>>(
      `UPDATE ${table} f SET envelope_id = m.envelope_id
       FROM (
         SELECT f2.id, f2.period_date, e.id AS envelope_id,
                row_number() OVER (PARTITION BY f2.id, f2.period_date ORDER BY (SELECT count(*) FROM jsonb_object_keys(e.dimension_values)) DESC, e.id) AS rn
         FROM ${table} f2 JOIN envelope e
           ON e.workspace_id = f2.workspace_id
          AND f2.period_date BETWEEN e.start_date AND e.end_date
          AND e.dimension_values <@ f2.dimension_values
          AND e.dimension_values <> '{}'::jsonb
          AND e.status <> 'ARCHIVED'
         WHERE f2.workspace_id = $1::uuid AND f2.source_run_id = $2::uuid AND f2.envelope_id IS NULL
       ) m
       WHERE f.id = m.id AND f.period_date = m.period_date AND m.rn = 1
       RETURNING f.envelope_id::text AS envelope_id`,
      workspaceId,
      runId,
    );
    for (const r of rows) matched.add(r.envelope_id);
  }
  return [...matched].sort();
}

export interface RunCoverage {
  spendRows: number;
  matchedSpendRows: number;
  spend: string;
  matchedSpend: string;
  kpiRows: number;
  matchedKpiRows: number;
}

/** Match coverage of a run (spec §24.3: matched spend / total spend), in reporting currency. */
export async function runCoverage(tx: Tx, workspaceId: string, runId: string): Promise<RunCoverage> {
  const [s] = await tx.$queryRaw<Array<{ rows: bigint; matched: bigint; spend: string; matched_spend: string }>>`
    SELECT count(*) AS rows, count(envelope_id) AS matched,
           coalesce(sum(amount_reporting), 0)::text AS spend,
           coalesce(sum(amount_reporting) FILTER (WHERE envelope_id IS NOT NULL), 0)::text AS matched_spend
    FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
  const [k] = await tx.$queryRaw<Array<{ rows: bigint; matched: bigint }>>`
    SELECT count(*) AS rows, count(envelope_id) AS matched FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid`;
  return {
    spendRows: Number(s?.rows ?? 0),
    matchedSpendRows: Number(s?.matched ?? 0),
    spend: s?.spend ?? "0",
    matchedSpend: s?.matched_spend ?? "0",
    kpiRows: Number(k?.rows ?? 0),
    matchedKpiRows: Number(k?.matched ?? 0),
  };
}

export interface UnmatchedGroup {
  dimensionValues: Record<string, string>;
  rows: number;
  amountReporting: string;
  firstDate: string;
  lastDate: string;
}

/** GET /unmatched-spend: unmatched spend grouped by tuple, largest first. */
export async function unmatchedSpend(tx: Tx, workspaceId: string, limit: number): Promise<UnmatchedGroup[]> {
  const rows = await tx.$queryRaw<Array<{ d: Record<string, string>; rows: bigint; amount: string; first: string; last: string }>>`
    SELECT dimension_values AS d, count(*) AS rows, sum(amount_reporting)::text AS amount,
           min(period_date)::text AS first, max(period_date)::text AS last
    FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND envelope_id IS NULL
    GROUP BY dimension_values ORDER BY sum(amount_reporting) DESC, dimension_values::text LIMIT ${limit}`;
  return rows.map((r) => ({ dimensionValues: r.d, rows: Number(r.rows), amountReporting: r.amount, firstDate: r.first, lastDate: r.last }));
}

/**
 * POST /unmatched-spend/map: every unmatched fact with exactly this tuple, inside the envelope's
 * dates, goes to the envelope. Returns rows assigned per table.
 */
export async function assignUnmatched(
  tx: Tx,
  workspaceId: string,
  dimensionValues: Record<string, string>,
  envelope: { id: string; startDate: string; endDate: string },
): Promise<{ spend: number; kpi: number; projection: number }> {
  const out = { spend: 0, kpi: 0, projection: 0 };
  const d = JSON.stringify(dimensionValues);
  for (const [key, table] of [["spend", "spend_fact"], ["kpi", "kpi_fact"], ["projection", "projection_fact"]] as const) {
    out[key] = await tx.$executeRawUnsafe(
      `UPDATE ${table} SET envelope_id = $2::uuid
       WHERE workspace_id = $1::uuid AND envelope_id IS NULL AND dimension_values = $3::jsonb AND period_date BETWEEN $4::date AND $5::date`,
      workspaceId,
      envelope.id,
      d,
      envelope.startDate,
      envelope.endDate,
    );
  }
  return out;
}
