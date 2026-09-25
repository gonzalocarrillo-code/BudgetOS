# Runbook: notifications (T-019, T-021, ADR-013, ADR-015)

- **Service:** `apps/workers/src/notify/main.ts` is a push subscriber for `alert.triggered`, `approval.changed` and `thread.changed`. The in-app consumer runs first, then Slack.
- **Slack configuration:**
  - `SLACK_BOT_TOKEN` (Secret Manager). The bot needs `chat:write` and `users:read.email`.
  - `workspace.settings.slack.defaultChannel` (for example `#budget-ops`), and optionally `delivery.slackChannel` per pacing rule.
  - `APP_BASE_URL` for deep links.
- **Nothing reaches Slack:** check the token (a log line says "no SLACK_BOT_TOKEN"), then check that the bot is invited to the channel. For DMs, the user's Budget OS email must match their Slack email.
- **Duplicates in Slack** are possible when a post succeeded but the worker died before committing its dedupe row. In-app notifications are never duplicated.
- **Who gets an in-app notification:**
  - mentions and followers, for `thread.changed`;
  - the alert owner, for an alert;
  - the current step's eligible approvers, for a new request;
  - the requester, for an outcome.
  - The actor is never notified of their own action.
