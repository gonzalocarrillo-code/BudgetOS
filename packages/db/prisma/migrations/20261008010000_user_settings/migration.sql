-- S-010 (docs/SLACK_TOOLSET_PLAN.md §3.6): a person's own settings. The first key is `slack`: the
-- workspace /budget answers for when several are linked to their Slack team. app_user stays
-- org-admin-write under RLS; app_set_my_slack_settings changes only the caller's settings.slack,
-- as app_set_my_name changes only their name.
-- Rollback: DROP FUNCTION IF EXISTS app_set_my_slack_settings(jsonb); ALTER TABLE app_user DROP COLUMN IF EXISTS settings;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION app_set_my_slack_settings(value jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  saved jsonb;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no user in this transaction'; END IF;
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RAISE EXCEPTION 'slack settings are an object'; END IF;
  UPDATE app_user SET settings = jsonb_set(settings, '{slack}', value) WHERE id = me RETURNING settings -> 'slack' INTO saved;
  RETURN saved;
END $$;
REVOKE ALL ON FUNCTION app_set_my_slack_settings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_my_slack_settings(jsonb) TO budget_app;
