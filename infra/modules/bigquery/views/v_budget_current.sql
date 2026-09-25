-- One row per envelope: its current budget (the latest BUDGET version approved, the planner's
-- rule, spec §6) in its own and the workspace reporting currency, and whether it is a live leaf.
-- Sum budgets over is_leaf rows only: a parent is a cap over its children (ADR-016).
SELECT
  e.workspace_id,
  e.id AS envelope_id,
  e.parent_id,
  e.name,
  e.status,
  e.dimension_values,
  e.start_date,
  e.end_date,
  e.owner_id,
  e.currency,
  v.amount,
  w.reporting_currency,
  v.amount_reporting,
  v.fx_rate_id,
  v.version_id,
  v.version_no,
  v.approved_at,
  COALESCE(k.live_children, 0) = 0 AS is_leaf
FROM `${project}.${dataset}.envelope` e
JOIN `${project}.${dataset}.workspace` w ON w.id = e.workspace_id
LEFT JOIN (
  SELECT
    x.envelope_id,
    x.id AS version_id,
    x.version_no,
    x.amount,
    x.amount_reporting,
    x.fx_rate_id,
    x.approved_at,
    ROW_NUMBER() OVER (PARTITION BY x.envelope_id ORDER BY x.approved_at DESC) AS rn
  FROM `${project}.${dataset}.envelope_version` x
  WHERE x.amount_type = 'BUDGET' AND x.status IN ('APPROVED', 'SUPERSEDED') AND x.approved_at IS NOT NULL
) v ON v.envelope_id = e.id AND v.rn = 1
LEFT JOIN (
  SELECT c.parent_id, COUNT(*) AS live_children
  FROM `${project}.${dataset}.envelope` c
  WHERE c.parent_id IS NOT NULL AND c.status <> 'ARCHIVED'
  GROUP BY c.parent_id
) k ON k.parent_id = e.id
