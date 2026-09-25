# ADR-025: Thread panel, comment editor without TipTap, emoji reactions per account

## Status

Accepted.

## Context

T-030 (spec §18.5) adds the Targets UI, the thread panel, the comment editor and tag chips. The done-when is the mention flow in Playwright. Spec §2 lists TipTap 2.x for comments, and §18.5 describes a `CommentEditor` built on TipTap's mention and reference extensions.

Plan 0.6 (product owner) asks for four things:
- a clear way to comment, including on approvals;
- emoji reactions by account;
- a clear, accessible edit history;
- comments always present in each budget.

## Decision

- **Comment editor: a plain textarea with an ARIA combobox, not TipTap.**
  - Comments are markdown text. The only rich parts are mentions, which the API stores as `@[user:id]` / `@[group:id]` (spec §13).
  - The editor shows `@Name` while typing. Typing `@` opens a listbox from `GET /workspaces/:ws/people?q` (↑/↓, Enter/Tab, Esc). Posting converts the picked names to the canonical form (`features/threads/mentions.ts`, unit tested); editing converts back.
  - This keeps a ~2 MB editor dependency out of the bundle, and the textarea is accessible by default.
  - `#[envelope:id]` references are still extracted by the server; a reference picker can come later without changing the stored form.
  - TipTap stays the documented upgrade path if rich text is needed. Its core and mention extension are MIT.
- **`GET /workspaces/:ws/people`** (`workspace.member`) lists who can be mentioned, by the same rule the comment commands enforce:
  - accounts with a role in the workspace, whether direct, org-wide or through a group;
  - the org's groups.
  - Matches are on name, or on email prefix.
- **Reactions by account.** Migration `20260925030000_comment_reactions` adds `comment_reaction(comment_id, user_id, emoji, workspace_id)`:
  - the primary key is (comment, user, emoji);
  - a CHECK constraint limits emoji to the fixed set `REACTIONS` (👍 ✅ 👀 🎉 ❤️ ❓, each with a spoken name);
  - it has RLS and a `budget_mcp` read grant.
  - `POST` / `DELETE /comments/:id/reactions {emoji}` need `thread.comment` and the anchor in scope. They are idempotent. A change writes one `reaction.added` / `reaction.removed` audit row and one `thread.changed` outbox row with no mentions, so nobody is notified.
  - `GET /threads` returns, per comment: `reactions: [{ emoji, name, count, users: [{ id, name }], mine }]`.
  - A reaction chip is a toggle button (`aria-pressed`) whose accessible name says the emoji, its name, the count and who reacted.
- **Edit history.** `GET /threads` returns `editHistory` (every earlier body, oldest first) from the existing `comment.edit_history`.
  - An edited comment shows an "edited (n)" button (`aria-expanded` / `aria-controls`) that lists each earlier version with its time.
- **Where comments live:**
  - every envelope drawer has Details / History / Comments tabs, and the Comments tab shows the open-thread count;
  - the approval request detail has its own Comments card (`approval_request` anchor);
  - the target drawer has Versions / Comments.
  - Envelope and target threads can be created as blocking.
- **Tag chips** in the drawer's Details apply and remove workspace tags (`/tags/apply`). Creating tags stays in Admin → Tags. `GET /envelopes/:id` returns `tags`.
- **Targets page:**
  - metric filter chips and a table (metric, scope, current target, draft, dates);
  - a drawer with every version, and "Propose a new value": a new draft version, then submit. Targets are never edited in place;
  - `GET /workspaces/:ws/targets` adds `envelopeName`.

## Consequences

- Spec §2's TipTap row is not used in Phase 1. The stored comment format is unchanged, so adopting TipTap later needs no migration.
- One new table, three new routes (permission-matrix rows included), and OpenAPI and the web client regenerated.
