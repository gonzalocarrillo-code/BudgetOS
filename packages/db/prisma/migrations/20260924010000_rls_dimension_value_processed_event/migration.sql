-- RLS for dimension_value and processed_event. Neither table has workspace_id; both inherit
-- tenancy from their parent, like the child tables in 0002_platform. The parent's own policy
-- applies inside the sub-select, so the org-scoped rules of 20260924000000 carry through.
--
-- dimension_value: `dimension_id = ANY (ARRAY(SELECT id FROM dimension))`. The sub-select is
-- uncorrelated, so it runs once per query as an InitPlan (an org has tens of dimensions) and
-- `= ANY($0)` stays an index condition on (dimension_id, …). A correlated EXISTS would probe
-- dimension once per value row, which the planner's dimension filters scan.
--
-- processed_event: `EXISTS (outbox)`. A consumer dedupes one event at a time by
-- (consumer, outbox_id), so this is a primary-key probe per row. It must run in withTenant()
-- for the event's workspace. Rows whose outbox row is gone are invisible, which is safe:
-- a deleted event is not redelivered.
--
-- Reverse: DROP POLICY tenant_isolation ON dimension_value; DROP POLICY tenant_isolation ON processed_event;
--          ALTER TABLE dimension_value NO FORCE ROW LEVEL SECURITY; ALTER TABLE dimension_value DISABLE ROW LEVEL SECURITY;
--          ALTER TABLE processed_event NO FORCE ROW LEVEL SECURITY; ALTER TABLE processed_event DISABLE ROW LEVEL SECURITY;

ALTER TABLE dimension_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimension_value FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dimension_value;
CREATE POLICY tenant_isolation ON dimension_value
  USING (dimension_id = ANY (ARRAY(SELECT d.id FROM dimension d)))
  WITH CHECK (dimension_id = ANY (ARRAY(SELECT d.id FROM dimension d)));

ALTER TABLE processed_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON processed_event;
CREATE POLICY tenant_isolation ON processed_event
  USING (EXISTS (SELECT 1 FROM outbox o WHERE o.id = outbox_id))
  WITH CHECK (EXISTS (SELECT 1 FROM outbox o WHERE o.id = outbox_id));
