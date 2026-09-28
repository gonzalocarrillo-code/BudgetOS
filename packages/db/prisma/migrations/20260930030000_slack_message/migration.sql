-- Slack messages the notify worker posted (product feedback 2026-09-28: the bot keeps its
-- messages current). When the alert or approval request a message is about changes — from Slack
-- or from the app — the worker edits that message (chat.update) instead of posting another.
CREATE TABLE IF NOT EXISTS slack_message (
  workspace_id uuid        NOT NULL,
  entity_type  text        NOT NULL CHECK (entity_type IN ('alert', 'approval_request')),
  entity_id    uuid        NOT NULL,
  channel      text        NOT NULL,
  ts           text        NOT NULL,
  posted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, ts)
);
CREATE INDEX IF NOT EXISTS slack_message_entity ON slack_message (entity_type, entity_id);
ALTER TABLE slack_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON slack_message;
CREATE POLICY tenant_isolation ON slack_message
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON slack_message TO budget_mcp;
