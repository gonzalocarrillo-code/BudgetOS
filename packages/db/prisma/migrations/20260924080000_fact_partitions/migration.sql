-- T-017: ingestion loads facts for any month, and budget_app cannot create tables. ensure_fact_partitions
-- becomes SECURITY DEFINER (the owner creates the partition) with a pinned search_path and a bounded
-- range, and budget_app may EXECUTE it (ADR-011).
--
-- Partitions carry no RLS of their own: only the partitioned parent does. Postgres checks privileges
-- on the parent for statements through it, so budget_app needs none on the partitions, and holding
-- them (from ALTER DEFAULT PRIVILEGES in 0001_roles) let a direct `SELECT … FROM spend_fact_202601`
-- skip the tenant policy. They are revoked on every existing partition, and on each new one.
--
-- ingest_run.summary (spec §24.3): match coverage and reject reasons per run; status gains 'queued'.
--
-- Reverse: ALTER TABLE ingest_run DROP COLUMN summary; restore the 0002_platform body (SECURITY INVOKER, no guard, no REVOKE),
--          REVOKE EXECUTE ON FUNCTION ensure_fact_partitions(date, int) FROM budget_app,
--          and GRANT SELECT, INSERT, UPDATE, DELETE on the partitions back to budget_app.
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m date; t text; p text; BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN RAISE EXCEPTION 'months_ahead must be 0..36, got %', months_ahead; END IF;
  IF from_month < DATE '2000-01-01' OR from_month > DATE '2100-01-01' THEN RAISE EXCEPTION 'from_month out of range: %', from_month; END IF;
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      p := format('%s_%s', t, to_char(m, 'YYYYMM'));
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', p, t, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE ALL ON %I FROM budget_app, PUBLIC', p);
    END LOOP;
  END LOOP; END $$;

REVOKE ALL ON FUNCTION ensure_fact_partitions(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_fact_partitions(date, int) TO budget_app;

DO $$ DECLARE r record; BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND parent.relname IN ('spend_fact', 'kpi_fact', 'projection_fact', 'audit_event')
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM budget_app, PUBLIC', r.relname);
  END LOOP;
END $$;

ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
