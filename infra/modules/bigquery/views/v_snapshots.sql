-- One row per budget per snapshot (docs/DATA_PLAN.md D-003, ADR-053): the snapshot's header with
-- each frozen row, so plan versus close across years is a GROUP BY. Archived snapshots are kept
-- (archived_at is set); nothing is ever deleted.
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
FROM `${project}.${dataset}.budget_baseline` b
JOIN `${project}.${dataset}.budget_baseline_row` r ON r.baseline_id = b.id AND r.workspace_id = b.workspace_id
