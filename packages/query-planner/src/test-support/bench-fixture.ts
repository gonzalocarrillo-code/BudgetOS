import { owner } from "./db.js";
import type { FixtureOrg } from "./fixtures.js";

/** Bulk SQL fixture for the planner bench: one approved version and `spendDays` spend rows per envelope. */
export async function seedBenchWorkspace(org: FixtureOrg, ws: string, envelopes: number, spendDays: number): Promise<void> {
  const geo = ["br", "br_sp", "mx", "de"].map((c) => org.values[c]!.id);
  const platform = ["meta", "google", "tiktok"].map((c) => org.values[c]!.id);
  // Bulk SQL so the bench fixture loads in well under a second.
  await owner.query(
    `WITH ins AS (
       INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       SELECT gen_random_uuid(), $1, 'B' || lpad(i::text, 5, '0'), '{}'::jsonb, '2026-01-01', '2026-03-31', 'USD',
              (CASE WHEN i % 5 = 0 THEN 'PENDING' ELSE 'APPROVED' END)::"EnvelopeStatus", $2, now()
       FROM generate_series(1, $3::int) i RETURNING id, name)
     INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id)
     SELECT id, $4::uuid, ($6::uuid[])[1 + substr(name, 2)::int % 4] FROM ins
     UNION ALL
     SELECT id, $5::uuid, ($7::uuid[])[1 + substr(name, 2)::int % 3] FROM ins`,
    [ws, org.users.u1, envelopes, org.dims.geo, org.dims.platform, geo, platform],
  );
  await owner.query(
    `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at)
     SELECT gen_random_uuid(), e.id, 1, 1000 + substr(e.name, 2)::int, 1000 + substr(e.name, 2)::int, 'APPROVED', $2, '2026-01-05'
     FROM envelope e WHERE e.workspace_id = $1`,
    [ws, org.users.u1],
  );
  await owner.query(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
     SELECT $1, e.id, '{}'::jsonb, '2026-01-01'::date + d, 'USD', 10 + d, 10 + d, 'bench', gen_random_uuid(), gen_random_uuid()::text
     FROM envelope e CROSS JOIN generate_series(0, $2::int - 1) d WHERE e.workspace_id = $1`,
    [ws, spendDays],
  );
  await owner.query(`ANALYZE envelope; ANALYZE envelope_dimension; ANALYZE envelope_version; ANALYZE spend_fact`);
}

/**
 * Projection facts for the bench: per envelope an older run over the whole of Q1 and a newer run
 * from mid-February into April (so the period bound matters). Every 7th envelope has none; every
 * 11th has only the newer run, entirely after the period. Plus unmatched rows (no envelope).
 */
export async function seedBenchProjections(ws: string): Promise<void> {
  await owner.query(
    `INSERT INTO projection_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id, loaded_at)
     SELECT $1, e.id, '{}'::jsonb, r.d, 'spend', 20 + n, 20 + n, 'bench_v1', '2026-04-30', 'bench', r.run, r.loaded_at
     FROM (SELECT e.id, substr(e.name, 2)::int AS n FROM envelope e WHERE e.workspace_id = $1) e
     CROSS JOIN LATERAL (
       SELECT gen_random_uuid() AS old_run, gen_random_uuid() AS new_run) u
     CROSS JOIN LATERAL (
       SELECT u.old_run AS run, '2026-02-01T00:00:00Z'::timestamptz AS loaded_at, d::date AS d
       FROM generate_series('2026-01-01'::date, '2026-03-31'::date, '1 day') d WHERE e.n % 11 <> 0
       UNION ALL
       SELECT u.new_run, '2026-02-15T00:00:00Z'::timestamptz, d::date
       FROM generate_series(CASE WHEN e.n % 11 = 0 THEN '2026-04-01'::date ELSE '2026-02-15'::date END, '2026-04-30'::date, '1 day') d) r
     WHERE e.n % 7 <> 0`,
    [ws],
  );
  await owner.query(
    `INSERT INTO projection_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id, loaded_at)
     SELECT $1, NULL, '{}'::jsonb, '2026-01-01'::date + d, 'spend', 5, 5, 'bench_v1', '2026-03-31', 'bench', gen_random_uuid(), now()
     FROM generate_series(0, 89) d`,
    [ws],
  );
  await owner.query(`ANALYZE projection_fact`);
}
