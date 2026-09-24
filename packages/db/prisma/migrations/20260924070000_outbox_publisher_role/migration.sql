-- T-016: the outbox publisher (spec §19) reads unpublished rows of every workspace and marks them
-- published. budget_app cannot (RLS narrows it to one workspace, or one org for an org admin), and
-- application code never uses the owner role. budget_publisher is a separate login with no table
-- grants except SELECT and UPDATE (published_at) on outbox and SELECT (id, org_id) on workspace (the
-- org travels with each message, so subscribers can open withTenant() for it), each with an RLS
-- policy for that role only. It still has NOBYPASSRLS: every other table stays closed to it (ADR-010).
--
-- Reverse: DROP POLICY publisher_all ON outbox; DROP POLICY publisher_read ON workspace;
--          REVOKE ALL ON outbox FROM budget_publisher; REVOKE ALL ON workspace FROM budget_publisher;
--          REVOKE USAGE ON SCHEMA public FROM budget_publisher; DROP ROLE budget_publisher;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'budget_publisher') THEN
    CREATE ROLE budget_publisher LOGIN NOBYPASSRLS PASSWORD 'replace-in-secret-manager';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO budget_publisher;
GRANT SELECT, UPDATE (published_at) ON outbox TO budget_publisher;

DROP POLICY IF EXISTS publisher_all ON outbox;
CREATE POLICY publisher_all ON outbox TO budget_publisher USING (true) WITH CHECK (true);

GRANT SELECT (id, org_id) ON workspace TO budget_publisher;
DROP POLICY IF EXISTS publisher_read ON workspace;
CREATE POLICY publisher_read ON workspace FOR SELECT TO budget_publisher USING (true);
