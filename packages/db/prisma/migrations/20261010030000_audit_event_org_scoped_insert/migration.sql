-- W2-4 (audit S-4): audit_event's INSERT policy was `WITH CHECK (true)` since 0002_platform and
-- was never replaced, and workspace_id is nullable, so any session that can reach audit_event —
-- including the read-only `budget_mcp` role, which holds INSERT on this table only (ADR-019) —
-- could write an audit row into another workspace's trail, or with workspace_id NULL,
-- impersonating an org-level event. The audit log is the evidence of record for approvals.
--
-- Fix: audit_event gets a nullable `org_id` (mirrors dimension's org-wide-row pattern: a NULL
-- workspace_id with an org_id is a legitimate org-level row, e.g. slack.service.ts
-- updateOrgSlack's "slack.org_linked"/"slack.org_unlinked", lifecycle.ts and org-people.ts's
-- superadmin actions). It is backfilled from workspace.org_id for workspace-scoped rows, and from
-- app_user.org_id via actor_id for NULL-workspace rows whose actor is known. New rows default
-- org_id from the tenant context (`app.org_id`, set by withTenant in every transaction) so
-- packages/db/src/sql.ts's audit() and every raw `INSERT INTO audit_event` (registry.ts, bulk.ts,
-- the workers' purge/retention/integrity paths, future hand-written migrations) need no code
-- change. audit_insert now requires the row's own workspace_id to be one of the session's visible
-- workspaces, or — when workspace_id is NULL — that the row's org_id is the session's own org.
-- That second branch deliberately does not also require app_is_org_admin(): apps/mcp/src/server.ts
-- writes an `mcp.list_workspaces` audit row (workspace_id NULL, the tool has no single workspace)
-- for every authenticated caller, not only org admins; requiring org-admin there broke that
-- legitimate, pre-existing write path (apps/mcp/src/tools.test.ts caught it). The org_id match
-- alone already closes S-4: a session can never write a NULL-workspace row claiming another org.
-- audit_read keeps the stricter, org-admin-only shape for NULL-workspace rows (the brief's ask):
-- before this migration they were not readable by anyone (workspace_id = ANY(...) is NULL, not
-- true, when workspace_id is NULL itself), and nothing in the codebase reads them back today, so
-- limiting read to org admins is the more conservative choice and does not need the same relief.
--
-- workspace_id stays nullable: per AGENTS.md, org-level rows are a legitimate shape (the same
-- pattern as dimension.workspace_id NULL for org-wide registry rows), not a gap to close with
-- NOT NULL.
--
-- Expand/contract: additive only (new column, new policy, new index). Old code that INSERTs
-- audit_event without naming org_id keeps working unchanged because the column defaults from the
-- session; old rows keep their place because the backfill runs before the DEFAULT is attached.
--
-- Reverse: DROP INDEX IF EXISTS audit_org_time;
--          DROP POLICY audit_read ON audit_event; CREATE POLICY audit_read ON audit_event FOR SELECT
--            USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
--          DROP POLICY audit_insert ON audit_event; CREATE POLICY audit_insert ON audit_event FOR
--            INSERT WITH CHECK (true);
--          ALTER TABLE audit_event ALTER COLUMN org_id DROP DEFAULT;
--          ALTER TABLE audit_event DROP COLUMN org_id;

ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS org_id uuid NULL;

-- Backfill before the DEFAULT is attached (a DEFAULT only governs new inserts), and before the
-- policy change (so budget's own migration role, which owns the table, is unaffected either way).
-- audit_event is append-only (audit_event_immutable trigger); this one-time backfill runs with it
-- disabled, cloned back onto every existing partition by Postgres's own ALTER TABLE cascade.
ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable;

UPDATE audit_event ae SET org_id = w.org_id
FROM workspace w
WHERE ae.workspace_id = w.id AND ae.org_id IS NULL;

UPDATE audit_event ae SET org_id = u.org_id
FROM app_user u
WHERE ae.workspace_id IS NULL AND ae.actor_id = u.id AND ae.org_id IS NULL;

ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable;

-- New rows: org_id defaults from the tenant context, the same way actor_context already defaults
-- from app.acting_as (0003_functions / registry migrations), so no caller needs to change.
ALTER TABLE audit_event ALTER COLUMN org_id SET DEFAULT nullif(current_setting('app.org_id', true), '')::uuid;

CREATE INDEX IF NOT EXISTS audit_org_time ON audit_event (org_id, occurred_at);

DROP POLICY IF EXISTS audit_insert ON audit_event;
CREATE POLICY audit_insert ON audit_event FOR INSERT WITH CHECK (
  (workspace_id IS NOT NULL AND workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  OR (workspace_id IS NULL AND org_id = app_org_id())
);

DROP POLICY IF EXISTS audit_read ON audit_event;
CREATE POLICY audit_read ON audit_event FOR SELECT USING (
  (workspace_id IS NOT NULL AND workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  OR (workspace_id IS NULL AND app_is_org_admin() AND org_id = app_org_id())
);
