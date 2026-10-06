# ADR-039: Editing a budget family top-down

## Status

Accepted.

## Context

Product feedback (2026-09-26): edit the whole budget family from the top down. Each child is set either:

- as a percentage of its parent, updating automatically when the parent changes; or
- manually, with a clear flag when the children don't add up to the parent.

Plan §4 names an Allocation entity (parent version → child version) that was never built. Parents are caps (ADR-016). An approved change is a new version, and a bulk change goes through one approval request, with parents approved first.

## Decision

- **Rules are rows.** `envelope_allocation` holds one current rule per child: `percent` (0–100, six decimals) or `manual`. A change supersedes the old row, which is kept. Saving rules writes one `audit_event` and one `outbox` row (`allocation.changed`) for the family. A child in another currency than its parent can only be manual; there is no FX in a share.
- **The plan is pure** (`family/plan.ts`) and runs top-down:
  - the parent's new amount is set;
  - each direct child is either its share of it or its own amount;
  - every child whose amount changes carries its own percent children with it, all the way down.
  - Manual children keep their amount.
  - Percent shares are split by largest remainder, so shares adding up to 100 % add up to the parent to the cent.
  - Each parent the plan touches gets a sum: `balanced`, `under` (unallocated) or `over`.
- **Routes:**
  - `GET /envelopes/:id/family`: the family as it is.
  - `POST …/family/preview`: what a change does, writing nothing.
  - `POST …/family`: saves the rules, then returns the existing bulk `paste` preview of every changed amount.

  The amounts are never written by these routes. The bulk commit makes the drafts and one approval request; the cap check and parents-first approval are unchanged.
- **"Automatically"** means within the family editor: change the parent, and the percent children (and theirs) move in the same change. A parent edited anywhere else does not rewrite its children behind the approver's back. The drawer's family card then shows the children no longer adding up, and one click opens the editor.
- **UI:**
  - The drawer of any parent shows the family card ("Children X of Y · Z unallocated / over by / they add up") with an Edit family button.
  - The editor lists the direct children with a % / Amount toggle, the resulting amounts live from the preview, the sum flag, and how many budgets further down follow.
  - Switching a child to % keeps its current share of the parent.

## Consequences

- One edit can reshape a whole subtree, and it is still one reviewable, approvable change.
- **Tests:**
  - `family/plan.test.ts`: splits, the cascade, the flags, and refusals.
  - `family/family.test.ts`: routes, rules, audit and outbox, the bulk preview and its commit.
  - `explorer.spec.ts`: the flow in the UI.

## Addendum (W3-5, 2026-10-05): one lock order for the budget tree

Audit I-15 found a lock-order inversion: a move locked the budget, then its new parent, then the open request; a decision locked the request, then the parent, then the budget. A concurrent move and decision deadlocked (Postgres `40P01`, surfacing as a 500), and so did cross-moves (A under B while B goes under A). Every write that touches the tree now takes its locks in one order, and validates only once it holds them:

1. **The workspace's tree lock** (`lockTreeShape`, a transaction advisory lock), taken by moves only. Row locks on the moved budgets and their parents cannot see a cycle closed by two moves in different parts of the tree (A under a descendant of B while B goes under a descendant of A), so moves run one at a time per workspace. Moves are rare; the wait is short.
2. **The approval request.** A move finds the budget's open request with a plain read, then locks it. A decision or a withdrawal starts with it.
3. **Envelopes, by id** (`lockEnvelopes`):
   - a move: the budget, its old parent and its new parent;
   - a decision or a withdrawal: every budget of the request and their parents (`lockRequestEnvelopes`);
   - a date change: the budget, its parent and its subtree.
4. **The workspace row** (`bumpDataVersion`), last.

Re-locking a row already held is a no-op, so the per-row locks taken later (`lockForWrite`, `lockParentCap`, `approveVersion`) never wait once the set is held. The order is written at the top of `apps/api/src/modules/envelopes/commands/structure.ts`.

A request submitted between the move's plain read and its locks shows up as a changed row version, and the move is refused with a 409 instead of locking that request out of order.

Tests in `structure.test.ts` ("lock order (W3-5)") cover:
- a move and a decision on the same budget, ten times at once;
- cross-moves;
- two moves that would close a cycle across different old parents.

None returns a 500. The loser of a cross-move gets the usual 422 cycle error.
