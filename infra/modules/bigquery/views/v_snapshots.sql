-- One row per budget per snapshot (docs/DATA_PLAN.md D-003, ADR-053): the snapshot's header with
-- each frozen row, so plan versus close across years is a GROUP BY. Archived snapshots are kept
-- (archived_at is set); nothing is ever deleted.
--
-- Datastream replicates in append-only mode (ADR-054 addendum, audit I-8): every Postgres INSERT,
-- UPDATE and DELETE lands as its own BigQuery row carrying datastream_metadata.{uuid,
-- source_timestamp, change_type}. These CTEs collapse each replicated table to its latest row per
-- primary key and drop rows whose latest change is a DELETE, before any business logic below runs.
-- budget_baseline_row's primary key is (baseline_id, envelope_id): no single id column. The
-- DATASTREAM_DEDUP markers let the Postgres parity check (bigquery-views.test.ts) strip the
-- BigQuery-only clause: Postgres's live table is already exactly one current row per primary key.
WITH budget_baseline AS (
  SELECT * FROM `${project}.${dataset}.budget_baseline`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
),
budget_baseline_row AS (
  SELECT * FROM `${project}.${dataset}.budget_baseline_row`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY baseline_id, envelope_id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
)
SELECT
  b.workspace_id,
  b.id AS snapshot_id,
  b.name AS snapshot_name,
  b.kind,
  b.period_key,
  b.as_of,
  b.created_at AS saved_at,
  b.archived_at,
  r.envelope_id,
  r.parent_id,
  r.name AS envelope_name,
  r.is_leaf,
  r.dimension_values,
  r.currency,
  r.amount,
  r.amount_reporting,
  r.version_id,
  r.start_date,
  r.end_date
FROM budget_baseline b
JOIN budget_baseline_row r ON r.baseline_id = b.id AND r.workspace_id = b.workspace_id
