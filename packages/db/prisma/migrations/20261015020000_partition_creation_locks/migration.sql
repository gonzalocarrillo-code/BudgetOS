-- W3-10 (found by the W0-1 CI run): month-partition creation deadlocked with ordinary readers and
-- writers (40P01). `CREATE TABLE ... PARTITION OF parent` takes ACCESS EXCLUSIVE on the parent, and
-- ensure_fact_partitions took it on spend_fact, kpi_fact, projection_fact and audit_event one after
-- another inside one transaction — often the caller's own write transaction, which already held
-- locks on some of those parents. Any session that held ACCESS SHARE on one parent and then asked
-- for another (a reader, a writer, the BigQuery view check) closed the cycle.
--
-- The new body never takes a lock stronger than SHARE UPDATE EXCLUSIVE on a parent:
--   1. Fast path unchanged: a month whose partitions exist costs one to_regclass per table, no lock.
--   2. Before any DDL, one transaction-scoped advisory lock serialises creators (it replaces the
--      old `LOCK TABLE parent IN SHARE UPDATE EXCLUSIVE MODE`, which was taken per parent, in turn).
--   3. The partition is built standalone — CREATE TABLE IF NOT EXISTS ... (LIKE parent), its
--      workspace FK (instantly valid: the table is empty), the REVOKE — and then
--      `ALTER TABLE parent ATTACH PARTITION`, which takes SHARE UPDATE EXCLUSIVE on the parent: it
--      does not conflict with ACCESS SHARE (reads) or ROW EXCLUSIVE (writes), so no reader or writer
--      ever waits on a creator, and a creator never waits on one. ATTACH builds the parent's
--      indexes on the new table (same names as PARTITION OF) and clones its row triggers
--      (audit_event_immutable), exactly like PARTITION OF did.
-- The resulting partition is the same as before: columns, defaults, CHECK and NOT NULL constraints,
-- indexes, the workspace FK, the trigger, no grant to budget_app.
--
-- The application side (same PR): ingest, pacing and demo seeding create the months they need in a
-- short transaction of their own before they open their write transaction, so creation no longer
-- runs inside a long caller transaction; the worker's daily pass still keeps six months ahead.
--
-- Expand-safe: same signature, grants and behaviour for the previous code.
-- Reverse: re-run the CREATE OR REPLACE FUNCTION ensure_fact_partitions of
-- 20261012000000_schema_invariants (and its REVOKE/GRANT lines).
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m date; t text; p text; locked boolean := false; BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN RAISE EXCEPTION 'months_ahead must be 0..36, got %', months_ahead; END IF;
  IF from_month < DATE '2000-01-01' OR from_month > DATE '2100-01-01' THEN RAISE EXCEPTION 'from_month out of range: %', from_month; END IF;
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      p := format('%s_%s', t, to_char(m, 'YYYYMM'));
      CONTINUE WHEN to_regclass(format('public.%I', p)) IS NOT NULL;
      IF NOT locked THEN
        -- Creators only; released at commit. Taken before any DDL and before any parent lock.
        PERFORM pg_advisory_xact_lock(hashtextextended('budget.ensure_fact_partitions', 0));
        locked := true;
      END IF;
      -- IF NOT EXISTS also refreshes this session's catalog view, so the check below sees a
      -- partition another creator committed while we waited for the advisory lock.
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED)', p, t);
      CONTINUE WHEN pg_partition_root(to_regclass(format('public.%I', p))) IS NOT NULL;
      EXECUTE format('REVOKE ALL ON %I FROM budget_app, PUBLIC', p);
      -- W3-11 (audit I-32): the new partition is empty, so a validated (non-NOT VALID) add is instant.
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT', p, p || '_workspace_id_fkey');
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', t, p, m, (m + interval '1 month')::date);
    END LOOP;
  END LOOP; END $$;

REVOKE ALL ON FUNCTION ensure_fact_partitions(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_fact_partitions(date, int) TO budget_app;
