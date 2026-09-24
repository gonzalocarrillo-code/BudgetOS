-- RLS for organization, workspace, app_user and app_group. All four are readable only within the
-- session's org (app.org_id, set by withTenant). The RLS helpers read them too:
-- app_visible_workspace_ids() reads workspace, and app_principal_in_org() reads app_user and
-- app_group. Both filter on org_id = app_org_id(), which is the same predicate as the policies,
-- so they return what they did before and nothing recurses.
--
-- Writes:
--   organization  budget_app never inserts or deletes; the org admin may update its own row.
--   workspace     org admin of the org; a session may also update its own workspace row
--                 (bumpDataVersion writes workspace.settings on every write path).
--   app_user      org admin of the org.
--   app_group     any session of the org. Groups sync (ADR-005) runs as a workspace admin; the
--                 route authorizes that.
--
-- The auth interceptor matches the token's user before it knows the org. withIdentity() sets
-- app.auth_subs (a JSON array) and app.auth_email from the verified token, and the app_user
-- policy additionally exposes the rows matching them. The email is set only when the provider
-- verified it. Nothing else is visible in that session.
-- A SECURITY DEFINER lookup would not work: FORCE ROW LEVEL SECURITY applies to the owner too.
--
-- Reverse: DROP the policies below and DISABLE / NO FORCE ROW LEVEL SECURITY on the four tables;
--          DROP FUNCTION app_auth_subs(); DROP FUNCTION app_auth_email();

-- 0002_platform's app_is_org_admin() casts current_setting() straight to boolean. After a
-- SET LOCAL transaction on a pooled connection the setting reads '' (not NULL), so a later
-- session that does not set it, like withIdentity(), failed with 22P02. Treat '' as false.
CREATE OR REPLACE FUNCTION app_is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.is_org_admin', true), ''), 'false')::boolean
$$;

CREATE OR REPLACE FUNCTION app_auth_subs() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    ARRAY(SELECT jsonb_array_elements_text(nullif(current_setting('app.auth_subs', true), '')::jsonb)),
    '{}'::text[])
$$;
CREATE OR REPLACE FUNCTION app_auth_email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.auth_email', true), '')
$$;
GRANT EXECUTE ON FUNCTION app_auth_subs(), app_auth_email() TO budget_app;

ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_read ON organization;
DROP POLICY IF EXISTS org_admin_update ON organization;
CREATE POLICY org_read ON organization FOR SELECT USING (id = (SELECT app_org_id()));
CREATE POLICY org_admin_update ON organization FOR UPDATE
  USING (id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()))
  WITH CHECK (id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()));

ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_read ON workspace;
DROP POLICY IF EXISTS org_admin_write ON workspace;
DROP POLICY IF EXISTS own_workspace_update ON workspace;
CREATE POLICY org_read ON workspace FOR SELECT USING (org_id = (SELECT app_org_id()));
CREATE POLICY org_admin_write ON workspace FOR ALL
  USING (org_id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()))
  WITH CHECK (org_id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()));
CREATE POLICY own_workspace_update ON workspace FOR UPDATE
  USING (id = (SELECT app_workspace_id()) AND org_id = (SELECT app_org_id()))
  WITH CHECK (id = (SELECT app_workspace_id()) AND org_id = (SELECT app_org_id()));

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_read ON app_user;
DROP POLICY IF EXISTS identity_read ON app_user;
DROP POLICY IF EXISTS org_admin_write ON app_user;
CREATE POLICY org_read ON app_user FOR SELECT USING (org_id = (SELECT app_org_id()));
CREATE POLICY identity_read ON app_user FOR SELECT
  USING (google_sub = ANY ((SELECT app_auth_subs())::text[]) OR email = (SELECT app_auth_email()));
CREATE POLICY org_admin_write ON app_user FOR ALL
  USING (org_id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()))
  WITH CHECK (org_id = (SELECT app_org_id()) AND (SELECT app_is_org_admin()));

ALTER TABLE app_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_group FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON app_group;
CREATE POLICY org_isolation ON app_group
  USING (org_id = (SELECT app_org_id()))
  WITH CHECK (org_id = (SELECT app_org_id()));
