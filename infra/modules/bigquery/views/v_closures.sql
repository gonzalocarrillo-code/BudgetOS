-- One row per period closure (restatements included, spec §15) with its fiscal period and the
-- BigQuery table that holds the frozen budget vs actual.
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
FROM `${project}.${dataset}.period_closure` c
JOIN `${project}.${dataset}.fiscal_period` p ON p.id = c.period_id
