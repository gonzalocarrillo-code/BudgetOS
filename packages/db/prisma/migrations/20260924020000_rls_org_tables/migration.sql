-- RLS for role_assignment, metric_definition, value_constraint and ingest_run. With these, every
-- public table budget_app reaches has RLS except the tenant roots and identity tables read
-- before a tenant exists (organization, workspace, app_user, app_group, app_group_member) and
-- global fx_rate. The guard test in packages/db/src/rls.org-admin.test.ts enforces this.
--
-- metric_definition (org_id): readable within the org; only the org admin writes, like
-- org-wide dimension rows.
-- value_constraint (dimension_id) and ingest_run (source_id) follow their parent, like the
-- child tables in 20260924010000. The uncorrelated ARRAY(SELECT …) runs once per query as an
-- InitPlan, and the parent's policy applies inside it.
--
-- role_assignment is an org identity table. Its principals (app_user, app_group) are org-wide,
-- and ORG_ADMIN rows have workspace_id NULL, so it is scoped by the principal's org:
--   read   rows whose principal belongs to app.org_id, in any workspace of the org. Groups sync
--          must see a group's grants in other workspaces to stop a workspace admin escalating
--          (ADR-005).
--   write  only rows in the session's visible workspaces, for a principal of app.org_id;
--          org-wide rows only with the org-admin bypass.
-- The tenant interceptor now reads assignments inside withTenant() with the user's org.
--
-- Reverse: DROP the policies below and DISABLE / NO FORCE ROW LEVEL SECURITY on the four tables;
--          DROP FUNCTION app_principal_in_org(text, uuid);

-- Inlined into the policy; one primary-key probe per role_assignment row read.
CREATE OR REPLACE FUNCTION app_principal_in_org(p_type text, p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'user' THEN EXISTS (SELECT 1 FROM app_user u WHERE u.id = p_id AND u.org_id = app_org_id())
    WHEN 'group' THEN EXISTS (SELECT 1 FROM app_group g WHERE g.id = p_id AND g.org_id = app_org_id())
    ELSE false
  END
$$;
GRANT EXECUTE ON FUNCTION app_principal_in_org(text, uuid) TO budget_app;

ALTER TABLE metric_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registry_read ON metric_definition;
CREATE POLICY registry_read ON metric_definition
  USING (org_id = (SELECT app_org_id()))
  WITH CHECK (org_id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()));

ALTER TABLE value_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_constraint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON value_constraint;
CREATE POLICY tenant_isolation ON value_constraint
  USING (dimension_id = ANY (ARRAY(SELECT d.id FROM dimension d)))
  WITH CHECK (dimension_id = ANY (ARRAY(SELECT d.id FROM dimension d)));

ALTER TABLE ingest_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingest_run;
CREATE POLICY tenant_isolation ON ingest_run
  USING (source_id = ANY (ARRAY(SELECT s.id FROM data_source s)))
  WITH CHECK (source_id = ANY (ARRAY(SELECT s.id FROM data_source s)));

ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_read ON role_assignment;
DROP POLICY IF EXISTS workspace_insert ON role_assignment;
DROP POLICY IF EXISTS workspace_update ON role_assignment;
DROP POLICY IF EXISTS workspace_delete ON role_assignment;
CREATE POLICY org_read ON role_assignment FOR SELECT
  USING (app_principal_in_org(principal_type, principal_id));
CREATE POLICY workspace_insert ON role_assignment FOR INSERT
  WITH CHECK (app_principal_in_org(principal_type, principal_id)
              AND (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])
                   OR (workspace_id IS NULL AND (SELECT app_is_org_admin()))));
CREATE POLICY workspace_update ON role_assignment FOR UPDATE
  USING (app_principal_in_org(principal_type, principal_id)
         AND (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])
              OR (workspace_id IS NULL AND (SELECT app_is_org_admin()))))
  WITH CHECK (app_principal_in_org(principal_type, principal_id)
              AND (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])
                   OR (workspace_id IS NULL AND (SELECT app_is_org_admin()))));
CREATE POLICY workspace_delete ON role_assignment FOR DELETE
  USING (app_principal_in_org(principal_type, principal_id)
         AND (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])
              OR (workspace_id IS NULL AND (SELECT app_is_org_admin()))));
