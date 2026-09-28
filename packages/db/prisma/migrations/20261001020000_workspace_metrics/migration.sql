-- ORG-007 (ADR-052): a workspace's own metrics. metric_definition was org-level only, so a
-- workspace admin could not define a KPI. A row with workspace_id is seen and changed only in that
-- workspace (and by the org-admin bypass); workspace_id NULL stays the shared library, written only
-- by a superadmin. Keys stay unique per org.
--
-- Reverse: DROP POLICY registry_read ON metric_definition; restore the policy from
--          20260924020000_rls_org_tables; ALTER TABLE metric_definition DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE metric_definition ADD COLUMN IF NOT EXISTS workspace_id uuid;
CREATE INDEX IF NOT EXISTS metric_definition_workspace_idx ON metric_definition (workspace_id) WHERE workspace_id IS NOT NULL;

DROP POLICY IF EXISTS registry_read ON metric_definition;
CREATE POLICY registry_read ON metric_definition
  USING (org_id = (SELECT app_org_id())
         AND (workspace_id IS NULL OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])))
  WITH CHECK (org_id = (SELECT app_org_id())
              AND ((SELECT app_is_org_admin())
                   OR (workspace_id IS NOT NULL AND workspace_id = (SELECT app_workspace_id()))));
