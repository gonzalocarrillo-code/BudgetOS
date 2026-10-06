-- W2-3 (audit S-2): the local runner's poll loop moves off the owner role (DATABASE_URL) onto
-- budget_publisher for its claim/mark AND its workspace-discovery queries
-- (packages/db/src/runner.ts: localActiveOrgs, localAllOrgs, localOrgsPendingPurge,
-- localWorkspacesForReindex), not only the outbox claim 20260924070000 already covered. Those
-- queries, and claimLocalOutbox itself, reference workspace.slug/status/deleted_at/created_at in
-- their WHERE and ORDER BY (Postgres checks column privileges on every column a query touches, not
-- only the SELECT list), plus workspace.purged_at for the purge-candidate scan, and
-- search_document.workspace_id for the reindex-candidate EXISTS check. Column-level grants only —
-- no table-wide GRANT, no new row-visibility policy on workspace (publisher_read already covers
-- it); search_document needs its own row policy, since its tenant_isolation policy requires a
-- workspace in session (app.workspace_id), which the publisher never sets.
--
-- Reverse:
--   DROP POLICY IF EXISTS publisher_read ON search_document;
--   REVOKE SELECT (workspace_id) ON search_document FROM budget_publisher;
--   REVOKE SELECT (slug, status, deleted_at, purged_at, created_at) ON workspace FROM budget_publisher;
GRANT SELECT (slug, status, deleted_at, purged_at, created_at) ON workspace TO budget_publisher;

GRANT SELECT (workspace_id) ON search_document TO budget_publisher;
DROP POLICY IF EXISTS publisher_read ON search_document;
CREATE POLICY publisher_read ON search_document FOR SELECT TO budget_publisher USING (true);
