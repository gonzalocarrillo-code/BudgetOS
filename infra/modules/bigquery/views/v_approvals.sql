-- One row per approval request with its latest decision and the number of decisions so far.
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
FROM `${project}.${dataset}.approval_request` r
LEFT JOIN (
  SELECT x.request_id, x.decided_by, x.decision, x.decided_at, ROW_NUMBER() OVER (PARTITION BY x.request_id ORDER BY x.decided_at DESC) AS rn
  FROM `${project}.${dataset}.approval_decision` x
) d ON d.request_id = r.id AND d.rn = 1
LEFT JOIN (
  SELECT y.request_id, COUNT(*) AS decisions
  FROM `${project}.${dataset}.approval_decision` y
  GROUP BY y.request_id
) n ON n.request_id = r.id
