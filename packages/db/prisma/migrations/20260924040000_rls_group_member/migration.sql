-- RLS for app_group_member, the last identity table without it. A membership follows its
-- app_group, whose policy (20260924030000) limits groups to app.org_id. The uncorrelated
-- ARRAY(SELECT id FROM app_group) runs once per query as an InitPlan, like the other child tables.
-- Writes also need the member to be a user of the same org: groups sync matches members by email
-- within the org, and this makes the database refuse a foreign-org member too.
-- The auth interceptor now reads memberships inside withTenant() with the user's org.
-- eligible_approver() (0003) reads this table as the invoker, inside a tenant session.
--
-- Reverse: DROP POLICY tenant_isolation ON app_group_member;
--          ALTER TABLE app_group_member NO FORCE ROW LEVEL SECURITY; ALTER TABLE app_group_member DISABLE ROW LEVEL SECURITY;

ALTER TABLE app_group_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_group_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_group_member;
CREATE POLICY tenant_isolation ON app_group_member
  USING (group_id = ANY (ARRAY(SELECT g.id FROM app_group g)))
  WITH CHECK (group_id = ANY (ARRAY(SELECT g.id FROM app_group g))
              AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = user_id AND u.org_id = (SELECT app_org_id())));
