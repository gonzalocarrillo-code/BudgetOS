# ADR-063: Slack as a working toolset

## Status

Accepted. Amends ADR-046. Plan: `docs/SLACK_TOOLSET_PLAN.md` (round 10).

## Context

Product feedback, round 10 (2026-09-29): approve, reject and send budgets for approval from Slack, by buttons and by commands, and see budgets with simple commands. ADR-046's bot had buttons on posted messages and three `/budget` answers, and had never run against a real Slack app. Reading it for this round found a Slack path that skipped the route permission, approval requests that never reached Slack, and approvers who were told only in a channel.

## Decision

- **Slack refuses what the app refuses.** Every button, form and command names the permission of the app route that does the same thing, and passes `authorize()` before the command runs; the command's own checks (scope, step eligibility, separation of duties) follow as in the app. A trusted email is lower-cased, and a superadmin acting in a workspace where they hold no role is marked `acting_as = superadmin`, as on the JWT path.
- **Access is Budget OS's.** One Slack team serves many workspaces. A person sees and acts only where their BudgetOS account holds a role; Slack channels are chosen per workspace (a private channel per client).
- **Every approval request announces itself.** Bulk edits and structural changes (split, merge, end, reintroduce, import, dates) write the `approval.requested` audit row and `approval.changed` outbox row that single changes write. The roll-up worker skips that event for bulk changes, whose `budget.changed` already refreshed the cache.
- **People are told where they are.** The notify worker sends each approver of the step a request waits on a direct message (on request, escalation, and each completed step), and the requester the outcome. Every direct message is recorded in `slack_message` and edited like the channel post. `approval.reminded` (the requester or an admin, once an hour) sends a new one. `settings.slack.dms` turns these off; mentions are always sent.
- **One list of outbox topics.** `OUTBOX_TOPICS` in `@budget/domain` names every topic and the workers that consume it. The local runner reads it, GCP's Pub/Sub topics are to be generated from it, and a test fails when code writes a topic it does not declare.
- **The API may answer the interaction it is handling.** ADR-046 kept every Slack message out of request handlers. The one exception: the API may POST to the `response_url` Slack gave for the interaction being handled, to replace the private (ephemeral) message a button sat on, such as the `/budget approvals` list, or to deliver a command's late answer. Ephemeral messages cannot be edited any other way. It never posts to a channel or a direct message; the worker does that. Only `https://hooks.slack.com/` addresses are accepted, and a refused response_url (after 30 minutes or 5 uses) leaves the action standing and tells the person to ask again.
- **One workspace answers each command.** Among the linked workspaces where the person holds a role: the one whose default or alerts channel the command was typed in; else the one they chose (`/budget workspace <name>`, or its button); else their only one; else the first by name, with a hint to choose. The choice is `app_user.settings.slack.defaultWorkspaceId`, a new JSON column written only through `app_set_my_slack_settings` (a definer function that changes the caller's own `settings.slack`, like `app_set_my_name`), audited as `user.slack_settings_changed` with a `user.updated` outbox row.
- **A change can be sent for approval from Slack.** `/budget request <name>`, or a budget card's "Request a change" (shown only to someone who may draft and send it), opens a form for the new amount and why. `submitDraft` writes the same draft as `PATCH /envelopes/:id/draft` and makes the same submission as `POST /envelopes/:id/submit`, in one transaction, each with its audit and outbox rows. The policy decides: a request for the approvers, or applied at once for an admin's own change. Only the amount and the reason can change from Slack (decision S5); dates, phasing and structure stay in the app. An amount is parsed strictly ("120,000.50"; never "12k"), and a budget changed since the form opened is refused, as in the app.
- **Identity stays the Slack email.** The plan also proposed remembering the Slack user id to skip `users.info`. That would need a lookup by Slack id on an identity table that row security exposes only by Google id or email, for one call that is already cached ten minutes, so it was left out.
- **Slow answers still arrive.** A command whose answer takes over 2.5 seconds replies "Working on it…" within Slack's three seconds and sends the answer through its response_url when ready. The API's own Slack calls (`users.info`, `views.open`, `auth.test`) time out after two seconds without retrying.
- **Requests have short ids.** `#` and the last eight hex characters of the request's UUID v7, whose tail is random. Every Slack message shows it, and `/budget` commands accept it, the full id, or a pasted link.

## Consequences

- A person whose Slack email does not match their BudgetOS email gets no direct messages and cannot act from Slack; they are told why when they try.
- A direct message goes to the step's role holders who pass `eligible_approver()`. Admins who may decide every step are not messaged unless they hold that role.
- The worker still makes Slack calls inside its `handleOnce` transaction (ADR-015, at least once). Slack user ids and direct-message channels are remembered for an hour per worker instance, and one event messages at most 25 people.
- Deployed, `budget-api` needs its `/api/v1/slack/*` paths reachable without IAP (Slack has no Google identity; those routes take only Slack-signed requests), one warm instance, and CPU after answering (Cloud Run "CPU always allocated"), or a late answer stalls once the response is sent.
