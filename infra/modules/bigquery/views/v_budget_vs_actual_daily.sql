-- Per envelope and day with matched spend: the day's actual, actual to date and what remains of
-- the current budget, all in the workspace reporting currency. Unmatched spend (envelope_id NULL)
-- is not here; KPIs are derived by the reader from spend and kpi facts, never stored.
--
-- v_budget_current is already deduped (it is a view, not a raw replicated table); spend_fact is
-- read directly, so it needs the same append-only de-dup as the other base views (ADR-054
-- addendum, audit I-8). The DATASTREAM_DEDUP markers let the Postgres parity check
-- (bigquery-views.test.ts) strip the BigQuery-only clause: Postgres's live table is already
-- exactly one current row per primary key.
WITH spend_fact AS (
  SELECT * FROM `${project}.${dataset}.spend_fact`
  -- DATASTREAM_DEDUP_START
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC) = 1
    AND datastream_metadata.change_type != 'DELETE'
  -- DATASTREAM_DEDUP_END
)
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
  FROM spend_fact s
  WHERE s.envelope_id IS NOT NULL
  GROUP BY s.envelope_id, s.period_date
) f ON f.envelope_id = b.envelope_id
