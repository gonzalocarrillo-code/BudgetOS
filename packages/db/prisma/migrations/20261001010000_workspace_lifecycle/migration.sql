-- ORG-002 / ORG-003 / ORG-001 (product feedback round 6, ADR-052): superadmins archive, restore and
-- delete workspaces, and their actions inside a workspace are marked in the audit trail.
--
-- workspace.status   ACTIVE | ARCHIVED. An archived workspace is read-only and visible to
--                    superadmins only; restoring it makes it ACTIVE again.
-- workspace.deleted_at  set when a superadmin deletes an archived workspace. The row stays as a
--                    tombstone so the org's audit trail keeps pointing at it; the purge worker
--                    removes the workspace's own rows after the retention window.
-- audit_event.actor_context  'superadmin' when the actor acted through the org-wide role inside a
--                    workspace. Filled from the session setting app.acting_as that withTenant()
--                    sets, so no audit call has to pass it.
--
-- Reverse: ALTER TABLE workspace DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS archived_at,
--          DROP COLUMN IF EXISTS archived_by, DROP COLUMN IF EXISTS deleted_at,
--          DROP COLUMN IF EXISTS purge_after, DROP COLUMN IF EXISTS purged_at;
--          ALTER TABLE audit_event DROP COLUMN IF EXISTS actor_context;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS archived_by uuid;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS purged_at timestamptz;
DO $$ BEGIN
  ALTER TABLE workspace ADD CONSTRAINT workspace_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS actor_context text DEFAULT nullif(current_setting('app.acting_as', true), '');
