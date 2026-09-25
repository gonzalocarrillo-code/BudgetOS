-- Per envelope and day with matched spend: the day's actual, actual to date and what remains of
-- the current budget, all in the workspace reporting currency. Unmatched spend (envelope_id NULL)
-- is not here; KPIs are derived by the reader from spend and kpi facts, never stored.
SELECT
  b.workspace_id,
  b.envelope_id,
  b.name,
  b.dimension_values,
  b.is_leaf,
  b.reporting_currency,
  f.period_date,
  f.actual_reporting,
  SUM(f.actual_reporting) OVER (PARTITION BY b.envelope_id ORDER BY f.period_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS actual_to_date_reporting,
  b.amount_reporting AS budget_reporting,
  b.amount_reporting - SUM(f.actual_reporting) OVER (PARTITION BY b.envelope_id ORDER BY f.period_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS remaining_reporting
FROM `${project}.${dataset}.v_budget_current` b
JOIN (
  SELECT s.envelope_id, s.period_date, SUM(s.amount_reporting) AS actual_reporting
  FROM `${project}.${dataset}.spend_fact` s
  WHERE s.envelope_id IS NOT NULL
  GROUP BY s.envelope_id, s.period_date
) f ON f.envelope_id = b.envelope_id
