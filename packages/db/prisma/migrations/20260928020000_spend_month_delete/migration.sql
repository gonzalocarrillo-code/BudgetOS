-- ADR-037 follow-up: removing the months a delete empties used a join of spend_month to the
-- statement's transition table. Transition tables have no statistics, so a large delete (a
-- workspace cleanup: millions of facts) got a plan that ran for hours. Emptied months are now
-- found through a partial index that holds only rows with no facts (normally none).
CREATE INDEX IF NOT EXISTS spend_month_empty ON spend_month (workspace_id) WHERE fact_count = 0;

CREATE OR REPLACE FUNCTION spend_month_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    INSERT INTO spend_month AS s (workspace_id, envelope_id, month, amount_reporting, fact_count)
      SELECT workspace_id, envelope_id, date_trunc('month', period_date)::date, -sum(amount_reporting), -count(*)
      FROM spend_old WHERE envelope_id IS NOT NULL GROUP BY 1, 2, 3
    ON CONFLICT (workspace_id, envelope_id, month) DO UPDATE
      SET amount_reporting = s.amount_reporting + EXCLUDED.amount_reporting, fact_count = s.fact_count + EXCLUDED.fact_count;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO spend_month AS s (workspace_id, envelope_id, month, amount_reporting, fact_count)
      SELECT workspace_id, envelope_id, date_trunc('month', period_date)::date, sum(amount_reporting), count(*)
      FROM spend_new WHERE envelope_id IS NOT NULL GROUP BY 1, 2, 3
    ON CONFLICT (workspace_id, envelope_id, month) DO UPDATE
      SET amount_reporting = s.amount_reporting + EXCLUDED.amount_reporting, fact_count = s.fact_count + EXCLUDED.fact_count;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM spend_month WHERE fact_count = 0 AND workspace_id IN (SELECT DISTINCT workspace_id FROM spend_old);
  END IF;
  RETURN NULL;
END $$;
