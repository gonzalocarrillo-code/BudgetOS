# ADR-015: notify-worker Slack delivery

## Status

Accepted.

## Context

T-021 (spec §19, plan §8.5) adds Slack delivery through Block Kit for alerts, approvals and mentions, next to the in-app channel from T-019. The done-when is Slack message snapshot tests, with no live Slack call. Plan §8.5 Phase 1 covers Slack channel posts for critical alerts and approval requests, and mention notifications. Per-user preferences, digests, email and interactive Slack approvals are Phase 2.

## Decision

- **Pure builders produce the messages.** `blocks/alert.ts`, `blocks/approval.ts` and `blocks/mention.ts` build Block Kit from plain inputs, and the snapshot tests pin them. Formatting rules:
  - mrkdwn control characters are escaped;
  - money stays a decimal string, with thousands grouped and the currency code shown;
  - deep links are `https://<APP_BASE_URL>/w/<ws>/…`;
  - buttons are links only: interactive approvals are Phase 2.
- **Where messages go:**
  - **Alerts:** the rule's `delivery.slackChannel`. Without one, critical alerts go to `workspace.settings.slack.defaultChannel` and everything else posts nothing.
  - **Approvals:** the default channel, for new requests, escalations, withdrawals and final outcomes (approved, rejected, changes requested). Intermediate step approvals don't post.
  - **Mentions:** a direct message to each mentioned user and each member of a mentioned group, found by email with `users.lookupByEmail`. Nobody gets a DM about their own comment, and people outside Slack get only the in-app notification.
- **Two consumers:** in-app (`notify-in-app`) and Slack (`notify-slack`) deduplicate separately.
  - If Slack fails, the push answers 500 and the redelivery skips the in-app step, which is already applied, then retries Slack.
  - A post that succeeds while its dedupe commit fails is sent again on redelivery, so Slack is at least once. Slack's `chat.postMessage` has no idempotency key.
- **In-app now also covers alerts and approvals:**
  - the alert's owner gets `alert`;
  - a new or escalated request notifies users holding the current step's role (directly or through a group) who pass `eligible_approver()`;
  - an outcome notifies the requester, and never the person who decided.
  - Dimension scope is checked when they open the request: the inbox filters by it.
- **Configuration:**
  - The token is `SLACK_BOT_TOKEN`, from Secret Manager in deployed environments. Without it, Slack delivery acknowledges and sends nothing, which is the local default.
  - `@slack/web-api` 8.1.1 (MIT).

## Consequences

- There's no live Slack call until a workspace and token exist (phase 20 or a pilot).
- Still open, all Phase 2:
  - the channel per workspace comes from `workspace.settings.slack.defaultChannel`, with no settings UI yet;
  - per-user notification preferences;
  - digests;
  - email.
