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
