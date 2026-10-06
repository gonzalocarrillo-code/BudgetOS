-- One row per period closure (restatements included, spec §15) with its fiscal period and the
-- BigQuery table that holds the frozen budget vs actual.
--
-- Datastream replicates in append-only mode (ADR-054 addendum, audit I-8): every Postgres INSERT,
-- UPDATE and DELETE lands as its own BigQuery row carrying datastream_metadata.{uuid,
-- source_timestamp, change_type}. These CTEs collapse each replicated table to its latest row per
-- primary key and drop rows whose latest change is a DELETE, before any business logic below runs.
-- The DATASTREAM_DEDUP markers let the Postgres parity check (bigquery-views.test.ts) strip the
-- BigQuery-only clause: Postgres's live table is already exactly one current row per primary key.
WITH period_closure AS (
  SELECT * FROM `${project}.${dataset}.period_closure`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
),
fiscal_period AS (
  SELECT * FROM `${project}.${dataset}.fiscal_period`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
)
SELECT
  c.workspace_id,
  c.id AS closure_id,
  c.status,
  c.closed_by,
  c.closed_at,
  c.bq_table,
  c.variance_summary,
  c.registry_version,
  p.key AS period_key,
  p.kind AS period_kind,
  p.start_date,
  p.end_date
FROM period_closure c
JOIN fiscal_period p ON p.id = c.period_id
