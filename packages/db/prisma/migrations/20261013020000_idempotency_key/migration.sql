-- W3-2 (audit I-6, spec §17, ADR-0081): `Idempotency-Key` on every mutating route. One row per
-- (scope, actor, key): the first request with a key claims the row (committed before the handler
-- runs), stores its status and JSON response when it succeeds, and deletes the row when it fails,
-- so a retry can run. A later request with the same key replays the stored response. Rows live
-- 24 h (the worker's daily sweep, apps/workers/src/idempotency/sweep.ts; a claim also ignores and
-- replaces its own key's expired row).
--
-- Three scopes, exactly one set per row (CHECK below):
--   - workspace_id: a workspace route (`:ws` or X-Workspace-Id), keyed per acting person;
--   - org_id: an org-level route with no workspace (`/org/*`, `/workspaces` create), per person —
--     the same NULL-workspace-with-org shape as audit_event since 20261010030000;
--   - slack_team_id: Slack's signed routes, where the person is only known inside the handler; the
--     key is derived from the signed request body, so Slack's own retries replay (actor_id NULL).
-- Read and written only through packages/db/src/idempotency.ts. The policy additionally limits a
-- person's session to their own rows; a system session (no app.user_id: the worker's daily sweep,
-- the workspace purge) and an org admin's org-wide session see every row of their workspaces/org.
-- Slack rows are visible only under the session's `app.slack_team_id`, which only idempotency.ts sets.
--
-- `response` is `json`, not `jsonb`: it keeps the body's text (key order included) exactly as first
-- sent, so a replay is byte-identical; nothing ever queries inside it.
--
-- Expand-only: a new table nothing old reads. `budget_app`'s CRUD comes from the ALTER DEFAULT
-- PRIVILEGES in 0001_roles; `budget_mcp` gets SELECT (ADR-019's readonly guard).
--
-- Reverse: REVOKE SELECT ON idempotency_key FROM budget_mcp; DROP TABLE IF EXISTS idempotency_key;
CREATE TABLE IF NOT EXISTS idempotency_key (
  id uuid PRIMARY KEY,
  workspace_id uuid NULL REFERENCES workspace (id) ON DELETE CASCADE,
  org_id uuid NULL REFERENCES organization (id) ON DELETE CASCADE,
  slack_team_id text NULL,
  actor_id uuid NULL,
  key text NOT NULL,
  route text NOT NULL,
  fingerprint text NOT NULL,
  status int NULL,
  response json NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT idempotency_key_one_scope CHECK (num_nonnulls(workspace_id, org_id, slack_team_id) = 1),
  CONSTRAINT idempotency_key_actor CHECK (slack_team_id IS NOT NULL OR actor_id IS NOT NULL),
  CONSTRAINT idempotency_key_key_length CHECK (length(key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_key_ws ON idempotency_key (workspace_id, actor_id, key) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_key_org ON idempotency_key (org_id, actor_id, key) WHERE workspace_id IS NULL AND org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_key_slack ON idempotency_key (slack_team_id, key) WHERE slack_team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_key_created ON idempotency_key (created_at);

ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON idempotency_key;
CREATE POLICY tenant_isolation ON idempotency_key
  USING (
    (workspace_id IS NOT NULL AND workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]) AND (actor_id = app_user_id() OR app_user_id() IS NULL OR app_is_org_admin()))
    OR (workspace_id IS NULL AND org_id IS NOT NULL AND org_id = app_org_id() AND (actor_id = app_user_id() OR app_user_id() IS NULL OR app_is_org_admin()))
    OR (workspace_id IS NULL AND org_id IS NULL AND slack_team_id = nullif(current_setting('app.slack_team_id', true), ''))
  )
  WITH CHECK (
    (workspace_id IS NOT NULL AND workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]) AND actor_id = app_user_id())
    OR (workspace_id IS NULL AND org_id IS NOT NULL AND org_id = app_org_id() AND actor_id = app_user_id())
    OR (workspace_id IS NULL AND org_id IS NULL AND slack_team_id = nullif(current_setting('app.slack_team_id', true), ''))
  );
GRANT SELECT ON idempotency_key TO budget_mcp;
