import type { Tx } from "./sql.js";

/** Fact loading and matching for the ingest pipeline (spec §14). Every statement runs in withTenant(). */

export interface SpendFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string; // yyyy-MM-dd
  currency: string;
  amount: string; // NUMERIC(18,2)
  amountReporting: string;
  fxRateId: string | null;
  /** ADR-071: the fact's natural key (its identity), written to natural_key and source_row_hash. */
  rowHash: string;
  /** T-036: provisional `external_id` / `match_key` when the normalizer resolved the tuple that way; the match confirms it. */
  matchMethod?: MatchHint | null;
}

export type MatchHint = "external_id" | "match_key";
export type MatchMethod = MatchHint | "tuple" | "manual";

export interface KpiFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string;
  metric: string;
  value: string; // NUMERIC(18,4)
  attributionModel: string | null;
  /** ADR-071: the fact's natural key, including the metric. */
  rowHash: string;
  matchMethod?: MatchHint | null;
}

export interface ProjectionFactInput {
  dimensionValues: Record<string, string>;
  periodDate: string;
  metric: string;
  value: string;
  /** W4-1: null for a non-money metric; never null for "spend" (mapped, or the workspace's reporting currency). */
  currency: string | null;
  valueReporting: string | null;
  /** W4-1: the FX rate used to convert `value` → `valueReporting`; null when currency is null or equals the reporting currency. */
  fxRateId: string | null;
  formulaVersion: string;
  horizonEnd: string;
  matchMethod?: MatchHint | null;
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
 * ADR-071: upserts spend facts on their identity, (workspace_id, natural_key, period_date). `rowHash`
 * is the natural key (the source's row id or business key, never the measure); it is also written to
 * source_row_hash, whose unique constraint stays until the contract migration. A reloaded fact takes
 * the new amount and run id (so the run's coverage counts it and reconciliation sees it), is live
 * again if it had been superseded, and keeps its envelope unless its dimension tuple changed (a
 * warehouse row re-keyed under the same row id): then it is unmatched and the run matches it again.
 */
export async function upsertSpendFacts(tx: Tx, load: FactLoad, rows: SpendFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO spend_fact (workspace_id, dimension_values, period_date, currency, amount, amount_reporting, fx_rate_id, source_system, source_run_id, source_row_hash, natural_key, match_method)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, c, a::numeric, ar::numeric, fx::uuid, ${load.sourceSystem}, ${load.sourceRunId}::uuid, h, h, mm
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.currency)}::text[],
                ${rows.map((r) => r.amount)}::text[], ${rows.map((r) => r.amountReporting)}::text[],
                ${rows.map((r) => r.fxRateId)}::text[], ${rows.map((r) => r.rowHash)}::text[], ${rows.map((r) => r.matchMethod ?? null)}::text[]) AS t(d, p, c, a, ar, fx, h, mm)
    ON CONFLICT (workspace_id, natural_key, period_date) WHERE natural_key IS NOT NULL DO UPDATE SET
      amount = EXCLUDED.amount, amount_reporting = EXCLUDED.amount_reporting, currency = EXCLUDED.currency,
      fx_rate_id = EXCLUDED.fx_rate_id, source_run_id = EXCLUDED.source_run_id, loaded_at = now(),
      superseded_at = NULL, superseded_by_run_id = NULL, dimension_values = EXCLUDED.dimension_values,
      envelope_id = CASE WHEN spend_fact.dimension_values = EXCLUDED.dimension_values THEN spend_fact.envelope_id END,
      match_method = CASE WHEN spend_fact.envelope_id IS NOT NULL AND spend_fact.dimension_values = EXCLUDED.dimension_values THEN spend_fact.match_method ELSE EXCLUDED.match_method END`;
}

/** As upsertSpendFacts, for KPI facts (the natural key includes the metric). */
export async function upsertKpiFacts(tx: Tx, load: FactLoad, rows: KpiFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO kpi_fact (workspace_id, dimension_values, period_date, metric, value, attribution_model, source_system, source_run_id, source_row_hash, natural_key, match_method)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, m, v::numeric, am, ${load.sourceSystem}, ${load.sourceRunId}::uuid, h, h, mm
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.metric)}::text[],
                ${rows.map((r) => r.value)}::text[], ${rows.map((r) => r.attributionModel)}::text[], ${rows.map((r) => r.rowHash)}::text[], ${rows.map((r) => r.matchMethod ?? null)}::text[]) AS t(d, p, m, v, am, h, mm)
    ON CONFLICT (workspace_id, natural_key, period_date) WHERE natural_key IS NOT NULL DO UPDATE SET
      value = EXCLUDED.value, attribution_model = EXCLUDED.attribution_model, source_run_id = EXCLUDED.source_run_id, loaded_at = now(),
      superseded_at = NULL, superseded_by_run_id = NULL, dimension_values = EXCLUDED.dimension_values,
      envelope_id = CASE WHEN kpi_fact.dimension_values = EXCLUDED.dimension_values THEN kpi_fact.envelope_id END,
      match_method = CASE WHEN kpi_fact.envelope_id IS NOT NULL AND kpi_fact.dimension_values = EXCLUDED.dimension_values THEN kpi_fact.match_method ELSE EXCLUDED.match_method END`;
}

/**
 * Projections are snapshots: each run inserts its own rows and the planner reads the latest run
 * (spec §6.2). W4-1: a money projection ("spend") carries its own currency and, when converted,
 * the fx_rate_id (same FxCache as spend facts, AGENTS §4: every amount carries currency, a
 * converted amount carries fx_rate_id). A non-money metric has both NULL.
 */
export async function insertProjectionFacts(tx: Tx, load: FactLoad, rows: ProjectionFactInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO projection_fact (workspace_id, dimension_values, period_date, metric, value, currency, value_reporting, fx_rate_id, formula_version, horizon_end, source_system, source_run_id, match_method)
    SELECT ${load.workspaceId}::uuid, d::jsonb, p::date, m, v::numeric, c, vr::numeric, fx::uuid, f, he::date, ${load.sourceSystem}, ${load.sourceRunId}::uuid, mm
    FROM unnest(${json(rows)}::text[], ${rows.map((r) => r.periodDate)}::text[], ${rows.map((r) => r.metric)}::text[],
                ${rows.map((r) => r.value)}::text[], ${rows.map((r) => r.currency)}::text[], ${rows.map((r) => r.valueReporting)}::text[],
                ${rows.map((r) => r.fxRateId)}::text[], ${rows.map((r) => r.formulaVersion)}::text[], ${rows.map((r) => r.horizonEnd)}::text[],
                ${rows.map((r) => r.matchMethod ?? null)}::text[]) AS t(d, p, m, v, c, vr, fx, f, he, mm)`;
}

/**
 * Spec §24.3 (replacing §14 step 5), for each fact table: an unmatched fact of this run goes to the most specific
 * live envelope whose tuple is a subset of the fact's tuple and whose dates cover the fact's date.
 * Returns the envelopes that gained facts.
 */
export async function matchRunFacts(tx: Tx, workspaceId: string, runId: string): Promise<string[]> {
  const matched = new Set<string>();
  for (const table of ["spend_fact", "kpi_fact", "projection_fact"] as const) {
    const rows = await tx.$queryRawUnsafe<Array<{ envelope_id: string }>>(
      // external_id / match_key resolved the fact's tuple before the upsert (the normalizer); the
      // tuple match finds the envelope and keeps that method, else records `tuple`.
      `UPDATE ${table} f SET envelope_id = m.envelope_id, match_method = coalesce(f.match_method, 'tuple')
       FROM (
         SELECT f2.id, f2.period_date, e.id AS envelope_id,
                row_number() OVER (PARTITION BY f2.id, f2.period_date ORDER BY (SELECT count(*) FROM jsonb_object_keys(e.dimension_values)) DESC, e.id) AS rn
         FROM ${table} f2 JOIN envelope e
           ON e.workspace_id = f2.workspace_id
          AND f2.period_date BETWEEN e.start_date AND e.end_date
          AND e.dimension_values <@ f2.dimension_values
          AND e.dimension_values <> '{}'::jsonb
          AND e.status <> 'ARCHIVED'
         WHERE f2.workspace_id = $1::uuid AND f2.source_run_id = $2::uuid AND f2.envelope_id IS NULL AND f2.superseded_at IS NULL
       ) m
       WHERE f.id = m.id AND f.period_date = m.period_date AND m.rn = 1
       RETURNING f.envelope_id::text AS envelope_id`,
      workspaceId,
      runId,
    );
    for (const r of rows) matched.add(r.envelope_id);
    // A provisional method on a fact that matched nothing is not a match method.
    await tx.$executeRawUnsafe(`UPDATE ${table} SET match_method = NULL WHERE workspace_id = $1::uuid AND source_run_id = $2::uuid AND envelope_id IS NULL AND match_method IS NOT NULL`, workspaceId, runId);
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
  /** T-036: spend rows and amount by how they matched (external_id, match_key, tuple, manual). */
  byMethod: Record<string, { rows: number; spend: string }>;
}

/** Match coverage of a run (spec §24.3: matched spend / total spend), in reporting currency. */
export async function runCoverage(tx: Tx, workspaceId: string, runId: string): Promise<RunCoverage> {
  const [s] = await tx.$queryRaw<Array<{ rows: bigint; matched: bigint; spend: string; matched_spend: string }>>`
    SELECT count(*) AS rows, count(envelope_id) AS matched,
           coalesce(sum(amount_reporting), 0)::text AS spend,
           coalesce(sum(amount_reporting) FILTER (WHERE envelope_id IS NOT NULL), 0)::text AS matched_spend
    FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND superseded_at IS NULL`;
  const [k] = await tx.$queryRaw<Array<{ rows: bigint; matched: bigint }>>`
    SELECT count(*) AS rows, count(envelope_id) AS matched FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND superseded_at IS NULL`;
  const methods = await tx.$queryRaw<Array<{ m: string; rows: bigint; spend: string }>>`
    SELECT match_method AS m, count(*) AS rows, coalesce(sum(amount_reporting), 0)::text AS spend
    FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND envelope_id IS NOT NULL AND superseded_at IS NULL
    GROUP BY match_method ORDER BY match_method`;
  return {
    spendRows: Number(s?.rows ?? 0),
    matchedSpendRows: Number(s?.matched ?? 0),
    spend: s?.spend ?? "0",
    matchedSpend: s?.matched_spend ?? "0",
    kpiRows: Number(k?.rows ?? 0),
    matchedKpiRows: Number(k?.matched ?? 0),
    byMethod: Object.fromEntries(methods.map((r) => [r.m ?? "none", { rows: Number(r.rows), spend: r.spend }])),
  };
}

/** The envelopes holding a run's live facts (any table): what a `facts.loaded` refresh must recompute. */
export async function runEnvelopes(tx: Tx, workspaceId: string, runId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT envelope_id::text AS id FROM (
      SELECT envelope_id FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND envelope_id IS NOT NULL AND superseded_at IS NULL
      UNION ALL SELECT envelope_id FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND envelope_id IS NOT NULL AND superseded_at IS NULL
      UNION ALL SELECT envelope_id FROM projection_fact WHERE workspace_id = ${workspaceId}::uuid AND source_run_id = ${runId}::uuid AND envelope_id IS NOT NULL AND superseded_at IS NULL
    ) f`;
  return rows.map((r) => r.id);
}

export interface Superseded {
  spend: number;
  kpi: number;
  projection: number;
  /** Envelopes that lost facts (their roll-ups must be recomputed). */
  envelopeIds: string[];
}

const SUPERSEDABLE = [
  ["spend", "spend_fact"],
  ["kpi", "kpi_fact"],
  ["projection", "projection_fact"],
] as const;

/**
 * ADR-071, full extract: the run is authoritative for its source over [from, to]. Every live fact of
 * the source dated in that range that this run did not load (or reload) is superseded by it. Facts
 * in `keep` ranges (closed periods the run may not restate) are left alone. Never deletes.
 */
export async function supersedeUnseenFacts(
  tx: Tx,
  args: { workspaceId: string; sourceId: string; runId: string; from: string; to: string; keep: Array<{ start: string; end: string }> },
): Promise<Superseded> {
  const out: Superseded = { spend: 0, kpi: 0, projection: 0, envelopeIds: [] };
  const envelopes = new Set<string>();
  for (const [key, table] of SUPERSEDABLE) {
    const [r] = await tx.$queryRawUnsafe<Array<{ n: bigint; envs: string[] | null }>>(
      `WITH s AS (
         UPDATE ${table} f SET superseded_at = now(), superseded_by_run_id = $3::uuid
         WHERE f.workspace_id = $1::uuid AND f.superseded_at IS NULL AND f.period_date BETWEEN $4::date AND $5::date
           AND f.source_run_id <> $3::uuid
           AND f.source_run_id IN (SELECT r.id FROM ingest_run r WHERE r.source_id = $2::uuid)
           AND NOT EXISTS (SELECT 1 FROM unnest($6::date[], $7::date[]) AS k(s, e) WHERE f.period_date BETWEEN k.s AND k.e)
         RETURNING f.envelope_id
       )
       SELECT count(*) AS n, array_agg(DISTINCT envelope_id::text) FILTER (WHERE envelope_id IS NOT NULL) AS envs FROM s`,
      args.workspaceId,
      args.sourceId,
      args.runId,
      args.from,
      args.to,
      args.keep.map((k) => k.start),
      args.keep.map((k) => k.end),
    );
    out[key] = Number(r?.n ?? 0);
    for (const e of r?.envs ?? []) envelopes.add(e);
  }
  out.envelopeIds = [...envelopes].sort();
  return out;
}

/**
 * ADR-071, sources with a row_id: a warehouse row is one fact. When the run (re)loaded a key on a new
 * date, the same key's live facts on other dates (from earlier runs) are superseded by it.
 */
export async function supersedeMovedFacts(tx: Tx, workspaceId: string, runId: string, table: "spend_fact" | "kpi_fact", keys: string[]): Promise<{ count: number; envelopeIds: string[] }> {
  if (keys.length === 0) return { count: 0, envelopeIds: [] };
  const [r] = await tx.$queryRawUnsafe<Array<{ n: bigint; envs: string[] | null }>>(
    `WITH s AS (
       UPDATE ${table} f SET superseded_at = now(), superseded_by_run_id = $2::uuid
       WHERE f.workspace_id = $1::uuid AND f.natural_key = ANY($3::text[]) AND f.source_run_id <> $2::uuid AND f.superseded_at IS NULL
       RETURNING f.envelope_id
     )
     SELECT count(*) AS n, array_agg(DISTINCT envelope_id::text) FILTER (WHERE envelope_id IS NOT NULL) AS envs FROM s`,
    workspaceId,
    runId,
    keys,
  );
  return { count: Number(r?.n ?? 0), envelopeIds: r?.envs ?? [] };
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
    FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND envelope_id IS NULL AND superseded_at IS NULL
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
      `UPDATE ${table} SET envelope_id = $2::uuid, match_method = 'manual'
       WHERE workspace_id = $1::uuid AND envelope_id IS NULL AND superseded_at IS NULL AND dimension_values = $3::jsonb AND period_date BETWEEN $4::date AND $5::date`,
      workspaceId,
      envelope.id,
      d,
      envelope.startDate,
      envelope.endDate,
    );
  }
  return out;
}

/**
 * T-039: for each (tuple, date), whether a live envelope would take a fact with that tuple on that
 * date (the same rule as matchRunFacts). Manual entry warns on rows that would land unmatched.
 */
export async function tuplesWithEnvelope(tx: Tx, workspaceId: string, rows: Array<{ dimensionValues: Record<string, string>; periodDate: string }>): Promise<boolean[]> {
  if (rows.length === 0) return [];
  const hits = await tx.$queryRaw<Array<{ i: bigint; hit: boolean }>>`
    SELECT t.i, EXISTS (
      SELECT 1 FROM envelope e
      WHERE e.workspace_id = ${workspaceId}::uuid AND e.status <> 'ARCHIVED' AND e.dimension_values <> '{}'::jsonb
        AND e.dimension_values <@ t.d::jsonb AND t.p::date BETWEEN e.start_date AND e.end_date
    ) AS hit
    FROM unnest(${rows.map((r) => JSON.stringify(r.dimensionValues))}::text[], ${rows.map((r) => r.periodDate)}::text[]) WITH ORDINALITY AS t(d, p, i)
    ORDER BY t.i`;
  return hits.map((h) => h.hit);
}
