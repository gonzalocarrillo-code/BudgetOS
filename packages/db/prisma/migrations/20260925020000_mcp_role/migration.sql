-- T-025 read-only MCP server (spec §16, ADR-019): the `budget_mcp` login role, the second line of
-- defence after "tools import only queries". It reads what budget_app reads, through the same RLS
-- policies (they apply to every role), and may only INSERT audit_event (one row per tool call).
-- No UPDATE or DELETE anywhere; nothing on the outbox tables. Partitions stay unreadable directly
-- (the parent's privilege covers partition-routed reads). A new table needs its own
-- `GRANT SELECT … TO budget_mcp`; apps/mcp/src/readonly.test.ts fails until it has one.
--
-- Reverse: REVOKE ALL ON ALL TABLES IN SCHEMA public FROM budget_mcp; REVOKE USAGE ON SCHEMA public FROM budget_mcp; DROP ROLE budget_mcp;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'budget_mcp') THEN
    CREATE ROLE budget_mcp LOGIN NOBYPASSRLS PASSWORD 'replace-in-secret-manager';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO budget_mcp;

DO $$ DECLARE r record; BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND NOT c.relispartition
      AND c.relname NOT IN ('_prisma_migrations', 'outbox', 'processed_event')
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO budget_mcp', r.relname);
  END LOOP;
END $$;

GRANT INSERT ON audit_event TO budget_mcp;
