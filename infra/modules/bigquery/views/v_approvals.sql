-- One row per approval request with its latest decision and the number of decisions so far.
--
-- Datastream replicates in append-only mode (ADR-054 addendum, audit I-8): every Postgres INSERT,
-- UPDATE and DELETE lands as its own BigQuery row carrying datastream_metadata.{uuid,
-- source_timestamp, change_type}. These CTEs collapse each replicated table to its latest row per
-- primary key and drop rows whose latest change is a DELETE, before any business logic below runs.
-- The DATASTREAM_DEDUP markers let the Postgres parity check (bigquery-views.test.ts) strip the
-- BigQuery-only clause: Postgres's live table is already exactly one current row per primary key.
WITH approval_request AS (
  SELECT * FROM `${project}.${dataset}.approval_request`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
),
approval_decision AS (
  SELECT * FROM `${project}.${dataset}.approval_decision`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
)
SELECT
  r.workspace_id,
  r.id AS request_id,
  r.entity_type,
  r.entity_id,
  r.policy_id,
  r.policy_version,
  r.status,
  r.summary,
  r.current_step,
  r.requested_by,
  r.requested_at,
  r.due_at,
  r.resolved_at,
  d.decided_by AS last_decided_by,
  d.decision AS last_decision,
  d.decided_at AS last_decided_at,
  COALESCE(n.decisions, 0) AS decisions
FROM approval_request r
LEFT JOIN (
  SELECT x.request_id, x.decided_by, x.decision, x.decided_at, ROW_NUMBER() OVER (PARTITION BY x.request_id ORDER BY x.decided_at DESC) AS rn
  FROM approval_decision x
) d ON d.request_id = r.id AND d.rn = 1
LEFT JOIN (
  SELECT y.request_id, COUNT(*) AS decisions
  FROM approval_decision y
  GROUP BY y.request_id
) n ON n.request_id = r.id
