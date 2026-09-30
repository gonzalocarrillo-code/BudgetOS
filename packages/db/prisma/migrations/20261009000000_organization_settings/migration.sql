-- R11-002 (docs/ORG_SLACK_SEARCH_PLAN.md §2.2): the organization's own settings, as the workspace
-- has. `slack` holds the Slack team the whole org answers to ({ teamId, teamName, linkedAt, linkedBy }).
-- RLS is unchanged: org_read lets the org's members read it, org_admin_update lets org admins write.
-- Down: ALTER TABLE organization DROP COLUMN settings;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
