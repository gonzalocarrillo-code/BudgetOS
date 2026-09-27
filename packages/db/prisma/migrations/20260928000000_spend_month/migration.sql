-- Monthly spend totals per envelope (ADR-037). The planner's `actual` sums whole months from here
-- and only the partial months at a period's edges from spend_fact: ~8 rows per leaf per year
-- instead of ~240 daily rows across 12 partitions. It is a sum of facts, not a KPI; KPIs are
-- still derived at query time. Statement-level triggers on spend_fact keep it exact for every
-- write path (ingest, manual entry, demo data, purge, re-matching an unmatched fact).
CREATE TABLE IF NOT EXISTS spend_month (
  workspace_id     uuid          NOT NULL,
  envelope_id      uuid          NOT NULL,
  month            date          NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_reporting numeric(18,2) NOT NULL,
  fact_count       bigint        NOT NULL,
  PRIMARY KEY (workspace_id, envelope_id, month)
);

ALTER TABLE spend_month ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_month FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON spend_month;
CREATE POLICY tenant_isolation ON spend_month
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON spend_month TO budget_mcp;

-- Adds the transition table's rows (sign +1) or removes them (-1); months left without facts go.
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
    DELETE FROM spend_month s USING (SELECT DISTINCT workspace_id, envelope_id, date_trunc('month', period_date)::date AS month FROM spend_old WHERE envelope_id IS NOT NULL) o
      WHERE s.workspace_id = o.workspace_id AND s.envelope_id = o.envelope_id AND s.month = o.month AND s.fact_count = 0;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS spend_month_ins ON spend_fact;
DROP TRIGGER IF EXISTS spend_month_upd ON spend_fact;
DROP TRIGGER IF EXISTS spend_month_del ON spend_fact;
CREATE TRIGGER spend_month_ins AFTER INSERT ON spend_fact REFERENCING NEW TABLE AS spend_new FOR EACH STATEMENT EXECUTE FUNCTION spend_month_apply();
CREATE TRIGGER spend_month_upd AFTER UPDATE ON spend_fact REFERENCING OLD TABLE AS spend_old NEW TABLE AS spend_new FOR EACH STATEMENT EXECUTE FUNCTION spend_month_apply();
CREATE TRIGGER spend_month_del AFTER DELETE ON spend_fact REFERENCING OLD TABLE AS spend_old FOR EACH STATEMENT EXECUTE FUNCTION spend_month_apply();

-- Backfill from the facts already loaded (re-runnable: recomputed from scratch).
DELETE FROM spend_month;
INSERT INTO spend_month (workspace_id, envelope_id, month, amount_reporting, fact_count)
  SELECT workspace_id, envelope_id, date_trunc('month', period_date)::date, sum(amount_reporting), count(*)
  FROM spend_fact WHERE envelope_id IS NOT NULL GROUP BY 1, 2, 3;
