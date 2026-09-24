-- Fix for 20260924080000: ensure_fact_partitions ran REVOKE on every existing partition on every
-- call. Ingest batches (T-017) and pacing evaluations (T-018) call it concurrently, and two
-- transactions updating the same pg_class ACL fail with "tuple concurrently updated". Now a
-- partition is created (and its privileges revoked) only when it does not exist yet, so the
-- common call touches no catalog rows. Creators serialise on a SHARE UPDATE EXCLUSIVE lock on the
-- parent: it conflicts only with itself (inserts keep running), and taking a relation lock
-- refreshes the catalog cache, so the re-check sees a partition another creator just committed.
-- (An advisory lock does not refresh the cache; the regression test caught that.)
--
-- Reverse: re-run the function body of 20260924080000_fact_partitions.
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m date; t text; p text; BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN RAISE EXCEPTION 'months_ahead must be 0..36, got %', months_ahead; END IF;
  IF from_month < DATE '2000-01-01' OR from_month > DATE '2100-01-01' THEN RAISE EXCEPTION 'from_month out of range: %', from_month; END IF;
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      p := format('%s_%s', t, to_char(m, 'YYYYMM'));
      CONTINUE WHEN to_regclass(format('public.%I', p)) IS NOT NULL;
      -- Only creators serialise; the lock is released at commit.
      EXECUTE format('LOCK TABLE %I IN SHARE UPDATE EXCLUSIVE MODE', t);
      CONTINUE WHEN to_regclass(format('public.%I', p)) IS NOT NULL; -- created while we waited
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', p, t, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE ALL ON %I FROM budget_app, PUBLIC', p);
    END LOOP;
  END LOOP; END $$;

REVOKE ALL ON FUNCTION ensure_fact_partitions(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_fact_partitions(date, int) TO budget_app;
