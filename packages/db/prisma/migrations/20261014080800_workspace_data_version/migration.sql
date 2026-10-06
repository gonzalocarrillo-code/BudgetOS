-- W3-8 (audit I-14, ADR-0082): the cache data version moves off the workspace row.
--
-- Until now every write path called bumpDataVersion(), an UPDATE of workspace.settings.dataVersion
-- inside the write's transaction, so the workspace row stayed locked from the bump to the commit:
-- a 10k-row bulk commit, or a close waiting on BigQuery, blocked every other write in the
-- workspace. The version now lives in its own row, bumped by a DEFERRABLE INITIALLY DEFERRED
-- constraint trigger on each outbox insert (every write path emits exactly one outbox row in its
-- transaction, AGENTS.md §4). Deferred, the bump runs at COMMIT, after every statement of the
-- transaction, so the row lock is held only for the commit itself, and versions still increase in
-- commit order (the next writer's bump waits for this one's commit).
--
-- Expand-only: the previous code keeps writing and reading workspace.settings.dataVersion (and
-- still bumps it); nothing here changes that key. Its value seeds this table. The trigger is
-- SECURITY INVOKER: the inserting session (budget_app) passes this table's tenant policy for the
-- same workspace_id the outbox row's own tenant policy already accepted.
--
-- Reverse:
--   DROP TRIGGER IF EXISTS outbox_bump_data_version ON outbox;
--   DROP FUNCTION IF EXISTS bump_workspace_data_version();
--   DROP TABLE IF EXISTS workspace_data_version;

CREATE TABLE IF NOT EXISTS workspace_data_version (
  workspace_id uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_data_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_data_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_data_version;
CREATE POLICY tenant_isolation ON workspace_data_version
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

-- budget_app: read it, and the trigger's upsert (DELETE for the workspace purge). budget_mcp: read it
-- (MCP results carry dataVersion). budget_publisher: nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_data_version TO budget_app;
GRANT SELECT ON workspace_data_version TO budget_mcp;
REVOKE ALL ON workspace_data_version FROM budget_publisher;

INSERT INTO workspace_data_version (workspace_id, version)
SELECT id, coalesce((settings->>'dataVersion')::bigint, 0) FROM workspace
ON CONFLICT (workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_workspace_data_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    INSERT INTO workspace_data_version AS v (workspace_id, version) VALUES (NEW.workspace_id, 1)
    ON CONFLICT (workspace_id) DO UPDATE SET version = v.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS outbox_bump_data_version ON outbox;
CREATE CONSTRAINT TRIGGER outbox_bump_data_version
  AFTER INSERT ON outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bump_workspace_data_version();
