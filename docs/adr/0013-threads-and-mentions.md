# ADR-013: Threads, mentions and who may resolve

## Status

Accepted.

## Context

T-019 (spec §13, plan §8.6) adds threads, comments, mentions, subscriptions and tags. The done-when is that a blocking thread blocks submit and a mention notifies. Four points needed deciding:

- Spec §13 says `thread.resolve` "requires author, anchor owner, or eligible approver on an open request for the anchor". The role matrix also grants `thread.resolve` to PLANNER, APPROVER and FINANCE. If a planner could resolve any blocking thread, "blocking" would mean little.
- Submit only checks blocking threads anchored on the envelope (spec §7.2) or the target (spec §10).
- A mention of someone who can't open the workspace would still send them the comment text.
- Nobody says where notifications are written. Spec §19 has notify-worker deliver them.

## Decision

- **Reading and commenting** need `thread.comment` in every scope of the anchor. Scopes come from `resolveAnchor`:
  - envelopes, cells and envelope versions: the envelope's dimensions;
  - targets: the target's scope;
  - approval requests and diff fields: every envelope of the request;
  - alerts: the alert's envelope;
  - closures and registry values: any workspace member.
- **Resolve and reopen** go to the thread's author, an owner of the anchor, an eligible approver of the current step of an open request on the anchor, or a workspace or org admin. The owner is the envelope or target owner, the alert owner, the requester, or whoever closed the period. The role action alone isn't enough.
- **`isBlocking`** is accepted only on `envelope` and `target` anchors, the two that submit checks. Blocking threads on approval requests stay the engine's own ("request changes" on a bulk change).
- **Mentions:**
  - use the canonical `@[user|group:<uuid>]` form (spec §13);
  - a mentioned user must hold a role in the workspace, directly or through a group, or the comment is refused (422);
  - a mentioned group must belong to the org.
- **Editing and deleting comments:**
  - An edit keeps the old body in `edit_history`, and only newly added mentions notify.
  - A delete is soft (`deleted_at`): the row and body stay, and reads return no body.
- **Notifications come from the worker, never the request.** Each write emits `thread.changed` with `{ threadId, commentId, action, actorId, anchor, mentions }`.
  - notify-worker's in-app handler (`handleThreadChanged`, deduplicated with `handleOnce`) writes one notification per user and event: `mention` for mentioned users and members of mentioned groups, `thread_activity` for followers.
  - Followers are subscribers of the thread or its anchor. Commenters follow the thread automatically.
  - The author is never notified. Edits and deletes notify only new mentions.
- **Tags:**
  - Creating and renaming or merging a tag needs `tag.create`; applying and removing needs `tag.apply`, and envelopes must be inside the caller's scope.
  - Apply and remove take up to 10k entities in one statement.
  - A merge moves the entities and deletes the emptied tag.
  - Every write emits `tag.changed`.

## Consequences

- Slack and email for mentions and subscriptions are T-021, through the same `thread.changed` events.
- There's no notification read API yet (the home screen, T-033).
- Mentions of users who can see the workspace but not the anchor's scope are allowed. The notification carries ids, not the body.
