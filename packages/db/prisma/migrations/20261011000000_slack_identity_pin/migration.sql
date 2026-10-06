-- W5-7 (audit S-14; ADR-075, amends ADR-065): a Slack workspace admin can set a colleague's email
-- on their own Slack profile and act as that colleague, because the bot trusted whoever currently
-- holds a given email in Slack (users.info), with no memory of which Slack account it last saw for
-- that app user. app_user.slack_user_id pins the Slack user id the first Slack-signed request for
-- an app user resolved to; apps/api/src/modules/slack/identity.ts refuses a later request whose
-- Slack user id differs from the pinned one, or whose Slack user id is already pinned to a
-- different app user of the org, with an ephemeral message naming the email. An org admin clears
-- the pin (PATCH /org/people/:id { slackUserId: null }) after a person's Slack account changes.
--
-- app_user stays org-admin-write under RLS (20260924030000_rls_identity_tables): a Slack-signed
-- session is never an org admin, so pinning its own first-contact slack_user_id needs a definer
-- function, exactly as app_set_my_name and app_set_my_slack_settings change only the caller's own
-- row. It changes slack_user_id only when it is NULL (first contact), and reports a conflict
-- instead of raising when the id already belongs to someone else in the org, so the caller gets a
-- clean refusal rather than a raw unique-violation.
--
-- Expand/contract: additive only (nullable column, partial unique index, new function). No old
-- code reads or writes slack_user_id, so nothing before this migration changes behavior.
--
-- Reverse: REVOKE EXECUTE ON FUNCTION app_link_my_slack_user(text) FROM budget_app;
--          DROP FUNCTION IF EXISTS app_link_my_slack_user(text);
--          DROP INDEX IF EXISTS app_user_org_slack_user_id;
--          ALTER TABLE app_user DROP COLUMN IF EXISTS slack_user_id;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS slack_user_id text NULL;

-- One Slack account pins to at most one app user per org (NULL rows are unpinned and excluded).
CREATE UNIQUE INDEX IF NOT EXISTS app_user_org_slack_user_id ON app_user (org_id, slack_user_id) WHERE slack_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_link_my_slack_user(p_slack_user_id text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  my_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  other uuid;
  mine text;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no user in this transaction'; END IF;
  IF my_org IS NULL THEN RAISE EXCEPTION 'no org in this transaction'; END IF;
  IF p_slack_user_id IS NULL OR length(btrim(p_slack_user_id)) = 0 THEN RAISE EXCEPTION 'a slack user id is required'; END IF;
  SELECT slack_user_id INTO mine FROM app_user WHERE id = me;
  IF mine IS NULL THEN
    -- Someone else in the org may already be pinned to this Slack account (the mismatch S-14
    -- guards against the other direction too: one Slack account cannot become two app users).
    SELECT id INTO other FROM app_user WHERE org_id = my_org AND slack_user_id = p_slack_user_id;
    IF other IS NOT NULL THEN
      RETURN jsonb_build_object('slackUserId', NULL, 'conflict', true);
    END IF;
    UPDATE app_user SET slack_user_id = p_slack_user_id WHERE id = me;
    mine := p_slack_user_id;
  END IF;
  RETURN jsonb_build_object('slackUserId', mine, 'conflict', false);
END $$;
REVOKE ALL ON FUNCTION app_link_my_slack_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_link_my_slack_user(text) TO budget_app;
