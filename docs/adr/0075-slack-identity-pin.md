# ADR-075: Pin the Slack identity to the app user (S-14)

## Status

Accepted. Amends ADR-065.

## Context

W5-7 (`docs/STACK_HARDENING_PLAN.md`, audit S-14): the bot (ADR-046) resolves who is acting from
Slack by asking Slack for the clicking or typing user's profile email (`users.info`) and matching it
to a Budget OS account (`authenticateVerifiedEmail`). That email is Slack's own, self-reported data —
a Slack **workspace admin** can edit anyone's profile, including the email field, from Slack's own
admin console. Setting a colleague's email on their own profile lets them act, and be audited, as
that colleague: approve, reject, acknowledge an alert, all `decided_by`/`actor_id` the victim's.

ADR-065 considered remembering the Slack user id, to skip the `users.info` call on every request,
and deliberately left it out: "That would need a lookup by Slack id on an identity table that row
security exposes only by Google id or email, for one call that is already cached ten minutes, so it
was left out." That reasoning still holds for the performance question it was answering. It does
not answer S-14's question, which is not "can we skip `users.info`" but "once we have the email,
and the app user it resolves to, is that a stable identity we can trust across requests."

## Decision

Keep calling `users.info` on every request, exactly as before (ADR-065's call stands). Add
`app_user.slack_user_id`, set once: the first time a Slack-signed request resolves to an app user
with no `slack_user_id` yet, that Slack user id is pinned to it (`app_link_my_slack_user`, a
`SECURITY DEFINER` function like `app_set_my_name` — a Slack-authenticated session is never an org
admin, so it cannot write `app_user` directly under RLS). Every later request re-checks the pin:

- the resolved email still points at the same app user, and the caller's Slack user id still
  matches that app user's `slack_user_id` → proceeds, unchanged from before;
- it differs (the app user is pinned to someone else's Slack account, or that Slack account is
  already pinned to a different app user of the org) → refused with an ephemeral message naming the
  email, logged as a warning with both Slack user ids.

A partial unique index, `(org_id, slack_user_id) WHERE slack_user_id IS NOT NULL`, makes the second
direction a database guarantee, not just an application check: one Slack account cannot pin to two
app users of an org, concurrently or otherwise.

An org admin clears the pin — `PATCH /org/people/:id { slackUserId: null }` — when a person's Slack
account genuinely changes (a re-hire, a Slack workspace migration), audited as `person.slack_unlinked`;
the next Slack-signed request from them re-pins to whichever Slack account resolves to their email
next, audited as `person.slack_linked`.

## Consequences

- The email a Slack admin sets no longer grants access by itself once a person has used `/budget` or
  a button once: the Slack **account** (its user id), not its current profile email, is what is
  trusted after first contact. This is strictly more conservative than ADR-046/065's original design.
- A person who is moved to a new Slack account (off-boarded and re-invited under the same email, a
  Slack-to-Slack migration) gets the relink refusal until an org admin clears the old pin. This is
  the intended trade-off: the alternative is trusting whoever currently holds the email, which is
  exactly S-14's hole.
- `audit_event` rows for the pin itself are org-level (`workspace_id NULL`, `org_id` set from the
  session, per the W2-4 migration): the identity is the app user's, not any one workspace's.
- No schema change to `OrgPerson`'s shape beyond the additive `slackUserId` field (null until first
  contact), and no change to how `users.info` is called or cached (`slack-api.ts`'s ten-minute cache
  is untouched).

## Related

- ADR-046: the Slack bot.
- ADR-065: Slack as a working toolset (amended here).
- `docs/STACK_AUDIT_2026-10-04.md` S-14, S-15.
- `apps/api/src/modules/slack/identity.ts`, `packages/db/prisma/migrations/20261011000000_slack_identity_pin/`.
