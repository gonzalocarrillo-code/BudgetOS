-- Org-scoped org-admin bypass (ADR-005 addendum, "still open").
-- 0002_platform / 0003_functions policies read `app_is_org_admin() OR workspace_id = app_workspace_id()`,
-- so an org-admin session could read every workspace of every organization. This migration limits the
-- bypass to the workspaces of `app.org_id` (set by withTenant from TenantContext.orgId), and limits
-- org-wide registry rows (dimension.workspace_id IS NULL) to the caller's org.
--
-- Shape: `workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])` is the same predicate as
-- `(app_is_org_admin() AND workspace_id IN (SELECT id FROM workspace WHERE org_id = app_org_id()))
--  OR workspace_id = app_workspace_id()`, but the scalar sub-select becomes a once-per-query InitPlan
-- and `= ANY($array)` is an index condition, so `(workspace_id, …)` indexes stay usable. The OR form
-- is not indexable on workspace_id and re-evaluates the helper per row.
--
-- Child tables (envelope_version, envelope_dimension, envelope_phasing, target_version,
-- approval_decision, comment, rule_state) keep their `EXISTS (parent)` policies: the parent's
-- policy applies inside that sub-select, so they narrow with it and are not touched here.
--
-- Reverse: re-run the RLS sections of 0002_platform and 0003_functions (policies back to the
-- `app_is_org_admin() OR workspace_id = app_workspace_id()` form), then
-- DROP FUNCTION app_visible_workspace_ids(); DROP FUNCTION app_org_id();

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- The session's own workspace, plus every workspace of its org when the org-admin bypass is on.
-- An org-admin session without app.org_id sees no bypass rows (fail closed).
CREATE OR REPLACE FUNCTION app_visible_workspace_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT array_remove(ARRAY[app_workspace_id()], NULL)
      || CASE WHEN app_is_org_admin()
              THEN coalesce((SELECT array_agg(w.id) FROM workspace w WHERE w.org_id = app_org_id()), '{}'::uuid[])
              ELSE '{}'::uuid[] END
$$;

-- workspace has no RLS; the helper runs as the caller. Index for the org lookup.
CREATE INDEX IF NOT EXISTS workspace_org_id_idx ON workspace (org_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'envelope','envelope_lineage','target','approval_policy','approval_request','pacing_rule','alert',
    'thread','tag','taggable','saved_view','period_closure','data_source','hierarchy_template','fiscal_period',
    'spend_fact','kpi_fact','projection_fact','rollup_cache','search_document','outbox',
    'subscription','notification','bulk_change'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])) WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))',
      t
    );
  END LOOP; END $$;

DROP POLICY IF EXISTS audit_read ON audit_event;
CREATE POLICY audit_read ON audit_event FOR SELECT USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

-- Org-wide registry rows are readable within their org; workspace rows by the visible workspaces.
-- Only an org admin writes org-wide rows, and only for its own org.
DROP POLICY IF EXISTS registry_read ON dimension;
CREATE POLICY registry_read ON dimension
  USING (org_id = (SELECT app_org_id())
         AND (workspace_id IS NULL OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])))
  WITH CHECK (org_id = (SELECT app_org_id())
              AND ((workspace_id IS NULL AND (SELECT app_is_org_admin()))
                   OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])));

GRANT EXECUTE ON FUNCTION app_org_id(), app_visible_workspace_ids() TO budget_app;
