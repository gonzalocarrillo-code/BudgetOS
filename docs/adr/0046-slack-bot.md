# ADR-046: The Slack bot: acting from Slack, and keeping its messages current

## Status

Accepted.

## Context

Product feedback (2026-09-28): "set up Slack notifications, and a Slack bot with alerts". The product owner chose three things:

- alert messages with Acknowledge / Snooze / Resolve;
- approving and rejecting from Slack;
- a `/budget` command for alerts, search and budget numbers.

T-021 already posted Block Kit messages from the notify worker, with link-only buttons.

## Decision

- **Who acts.**
  - A Slack request is verified with Slack's signature (`SLACK_SIGNING_SECRET`, five-minute window), under a new route permission `slack.signed` that takes no JWT.
  - The Slack user becomes the Budget OS account with their Slack profile email (`users.info`), through `authenticateVerifiedEmail`: the same active-user, same-org and role checks as a JWT.
  - This only works in a workspace linked to that Slack team (`workspace.settings.slack.teamId`, read with `auth.test` when an admin presses Link).
  - The action runs the same command as the app (`updateAlert`, `decide` with `channel: "slack"`), so permissions, scope, separation of duties, audit and outbox are unchanged.
  - A refusal is shown to that person only, in a small Slack form.
- **What the API asks Slack.** Messages are never posted or edited from a request handler (AGENTS.md §4). The handler makes only these calls, which Slack's three-second window requires:
  - `users.info` (identity);
  - `views.open` (the reject-reason form, and refusal messages; the trigger expires in 3 s);
  - `auth.test` (linking).
- **Keeping messages current.**
  - The notify worker records each alert or approval message it posts (`slack_message`: channel and ts).
  - When the alert changes (`alert.changed`) or the request is decided (`approval.changed`), it edits those messages (`chat.update`), whoever acted and wherever. Buttons disappear once there is nothing left to do.
- **Routing.**
  1. A rule's channel wins.
  2. Else the workspace's alerts channel, for the severities it takes.
  3. Else the default channel, for critical alerts only.

  Approval requests go to the default channel, with Approve / Reject unless turned off.
- **`/budget`** answers only the person asking (an ephemeral reply): `alerts`, `search <text>`, or a budget's name. It reads the first linked workspace where they have a role.
- **Admin › Slack** (`user.manage`):
  - connection status and Link;
  - channels and severities;
  - a test message (the outbox topic `slack.test`, posted by the worker);
  - the setup steps with the app manifest and the URLs Slack calls.
- **Local.** The local runner now delivers the notify topics (in-app notifications and Slack), and serves every workspace in the local stack's org (`LOCAL_ORG_FROM`), not only slugs starting with "local".

## Consequences

- The bot token and signing secret are environment secrets. A Slack app is created once per Budget OS deployment from the manifest.
- The bot cannot recognise a Slack user whose profile email doesn't match a Budget OS account. They are told so.
- On localhost, buttons and `/budget` need a public tunnel to the API (`API_PUBLIC_URL`). Posting works without one.
