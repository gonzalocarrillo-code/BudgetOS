# Runbook: notifications (T-019, T-021, ADR-013, ADR-015)

- **Service:** `apps/workers/src/notify/main.ts` is a push subscriber for the topics `OUTBOX_TOPICS` gives the notify worker (`packages/domain/src/outbox-topics.ts`). The in-app consumer runs first, then Slack. The Slack bot's setup and commands are in `docs/runbooks/slack.md`.
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

## Slack bot (ADR-046)

- **Environment:**
  - `SLACK_BOT_TOKEN`: posting and editing, plus `users.info`, `views.open` and `auth.test`.
  - `SLACK_SIGNING_SECRET`: verifies `/api/v1/slack/interactions` and `/api/v1/slack/commands`.
  - `API_PUBLIC_URL`: what Slack calls.
  - `APP_BASE_URL`: links in messages.
- **Setup:** Admin › Slack has the steps and the app manifest. Create the app from the manifest, install it, invite the bot to its channels, set the env, then Link and send a test.
- **Topics:** the notify worker takes the topics `OUTBOX_TOPICS` gives it (`packages/domain/src/outbox-topics.ts`): alerts, `approval.changed`, `approval.reminded`, `thread.changed` and `slack.test`.
- **Approval direct messages (S-004):** each approver of the step a request waits on gets a direct message (on request, escalation and each completed step), recorded in `slack_message` and edited like the channel post; the requester gets the outcome unless they acted themselves; `approval.reminded` sends the approvers a new one. `settings.slack.dms = false` turns these off (mentions are still sent). A person gets them only if their BudgetOS email matches their Slack email.
- **`slack_message`** records the posted messages it edits. Losing it only means later changes post nothing instead of editing.
- **"Your Slack profile has no email…" / "No active Budget OS account…":** the Slack user's email doesn't match a Budget OS user. Add them in Admin › Roles with the same email.
