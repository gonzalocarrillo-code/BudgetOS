-- W3-6 (audit I-21): Slack posts happened inside the notify-worker's consumer transaction
-- (apps/workers/src/notify/slack.ts), so a later statement in that same transaction failing rolled
-- back the `slack_message` row recording a post the bot had already made to the real Slack API.
-- Redelivery then found no record of it and posted again instead of editing.
--
-- Fix: the consumer transaction now only decides what to post and records that decision here, with
-- `ts` left null; Slack is called afterwards, outside the transaction, and `ts` is set by its own
-- short follow-up statement per post (packages/db/src/slack.ts). A post that fails leaves every
-- earlier post's `ts` already committed; redelivery finds the still-null rows and posts only those,
-- skipping the ones already sent. `(outbox_id, channel, dedupe_key)` is unique so recording the same
-- decision twice (the same belt-and-suspenders as `processed_event`) is a no-op.
--
-- Expand/contract: purely additive (new table only); old code paths are unaffected.
--
-- Reverse: DROP TABLE IF EXISTS slack_delivery;

CREATE TABLE IF NOT EXISTS slack_delivery (
  id           uuid        NOT NULL,
  workspace_id uuid        NOT NULL,
  outbox_id    bigint      NOT NULL,
  channel      text        NOT NULL,
  dedupe_key   text        NOT NULL,
  message      jsonb       NOT NULL,
  about_type   text        NULL CHECK (about_type IS NULL OR about_type IN ('alert', 'approval_request')),
  about_id     uuid        NULL,
  ts           text        NULL,
  posted_at    timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (outbox_id, channel, dedupe_key)
);
CREATE INDEX IF NOT EXISTS slack_delivery_pending ON slack_delivery (outbox_id) WHERE ts IS NULL;

ALTER TABLE slack_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON slack_delivery;
CREATE POLICY tenant_isolation ON slack_delivery
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

-- ADR-019: a new table needs its own grant or apps/mcp/src/readonly.test.ts fails.
GRANT SELECT ON slack_delivery TO budget_mcp;
