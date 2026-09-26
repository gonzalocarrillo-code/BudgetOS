# ADR-027: Envelope structure from the UI: add child, move, split, merge, with a server preview

## Status

Accepted.

## Context

Plan 0.6 §9.3 (product owner) asks that parent and child envelopes be easy to set up from the tree or the drawer: add a child under any envelope, move one under a new parent, split one into children, merge siblings. Each should be one action with a preview (caps, totals) and go through the same versioning and approval.

T-014 already has move, split and merge (spec §7.5). It has no add-child action and no preview. The rules forbid computing totals or roll-ups in the browser.

## Decision

- **`POST /envelopes/structure/preview`** (`envelope.read`) takes `{ op: add_child | move | split | merge, … }` (`StructurePreviewInput`).
  - It runs **the real command** in a transaction and throws a rollback sentinel, so nothing is written: no rows, no audit, no outbox.
  - The preview therefore makes every check the change would make: caps, cycles, locks, archived parents, scope and permission, "parts must sum", open requests, policy routing.
  - It returns:
    - `{ ok: true, amount, parent, previousParent, routing }`, where each parent is its approved amount, its children's approved total before → after, what is left, and whether it goes over the cap, all in the reporting currency; and `routing` is `immediate` (a move), `auto_approved` with the policy, or `approval` with the policy and its step roles;
    - or `{ ok: false, error: { code, message, details } }`, which the dialog shows while its Commit is disabled with that reason.
  - To make this possible, the commands were split into their transaction bodies (`createEnvelopeIn`, `submitVersionIn`, `moveIn`, `splitIn`, `mergeIn`). The public commands wrap them in `withTenant` unchanged, and their behaviour is unchanged (T-014's tests pass).
- **`POST /envelopes/:id/children`** (`envelope.create`), `AddChildInput { name, amount, dimensionValues, rationale }`:
  - one action: create the child under the parent (its dates, currency, owner and period, and its dimensions with the given keys overriding), then **submit** its draft in the same transaction;
  - the child is new money, so the policies route it like any other change (Standard: budget owner, then approver, in the golden workspace);
  - each part keeps its own audit and outbox rows (`envelope.created`, `approval.requested` / approved).
- **`GET /envelopes/:id` adds `structure`:** the parent, the live children and the live siblings, each with its approved amount and dimension values. Ones outside the caller's scope are left out. The drawer shows the parent (a link) and the children (links, with amounts). The merge dialog picks siblings from this list.
- **UI:**
  - Structure actions ("Add child", "Move under…", "Split", "Merge") sit in the Explorer toolbar (acting on the selected budget) and in the drawer's Details. Each is disabled with a reason when it cannot run: nothing selected, a closed period, archived, no approved amount, a change pending.
  - One dialog per action:
    - add child: name, amount, and the dimensions the parent does not set;
    - move: current parent, search for the new one, or top level;
    - split: parts with names and amounts, "split evenly" (largest remainder), add a part;
    - merge: siblings in the same currency, and a name. The merged budget keeps the dimension values its sources share.
  - The live preview refreshes 350 ms after the user stops typing. Commit reads "Submit for approval", "Apply" or "Move", depending on the routing. After a commit, a notice links to the approval request when there is one.
- **Out of scope:**
  - Drag and drop in the canvas tree. Glide draws on canvas and has no row drag; the toolbar acts on the selected row instead.
  - Moves still apply at once (spec §7.5): caps are checked and an open request is re-routed, but a move is not itself approval-gated.

## Consequences

- One preview route and one command route (permission-matrix rows); OpenAPI and the web client regenerated.
- Every preview is a real, short transaction that takes the same row locks as the change. The dialog waits 350 ms after typing before previewing, and each preview holds its locks only for as long as the command takes.
