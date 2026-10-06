# ADR-060: A budget's dates are editable, through approval once it has an approved amount

## Status

Accepted (product feedback 2026-09-29). Decisions by the product owner:
- A date change to an approved budget goes through approval, like ending early.
- When a parent's new dates leave children outside, the app asks before moving them too.

## Context

"Dates should be editable, everywhere." Until now a budget's dates were set on create and changed only by ending early. `PATCH /envelopes/:id` accepted `startDate` and `endDate`, but no screen used it: it changed an approved budget's dates in place, with no approval, left the phasing outside the new dates, and left the children where they were.

## Decision

- **`POST /envelopes/:id/dates`**, with `/dates/preview` beside it. The preview writes nothing and lists every budget the change moves (the budget, then the children it trims), whether each one's phasing is re-spread, and whether the change needs approval.
- **Approval.** When any budget in the change has an approved amount, the change is one bulk change of kind `dates`, routed through the approval policy like an early end:
  - Each budget with an approved amount gets a new version with the same amount, its phasing re-spread into the new dates.
  - The dates apply when the change is approved. A rejection or withdrawal leaves every budget as it was.
  - An admin's change applies at once (ADR-048).
- **What the policy judges.** The policy reads the share of the budget's days that move (1 − overlap ÷ the longer of the two ranges), as `deltaPct` and as that share of the amount in `deltaAbs`. A one-day extension is therefore minor (the "Auto-approve minor" default), and a quarter shifted by a month goes to approval. A change with no amount difference would otherwise always match "Auto-approve minor".
- **A budget never approved** changes at once. If its draft has phasing outside the new dates, that phasing moves into a new draft.
- **Parents and children.**
  - The new dates must fit inside the parent's dates; otherwise, change the parent first.
  - Children that would fall outside are trimmed to the new dates (and their children to theirs), but only with `trimChildren`. Without it the change is refused with the list of those children, which the dialog shows with a tick box.
  - A child entirely outside the new dates, or one that has ended, must be moved or ended first.
- **Phasing.** Months still inside the new dates keep their shape, scaled back to the same amount. When no month is left, the amount spreads over the new months by their days. A version without phasing stays without phasing.
- **Guards.** A budget waiting for approval, or with an unsent draft, is refused: withdraw the request, or send or discard the draft, first. `PATCH /envelopes/:id` refuses dates on a budget with an approved amount.
- **Screens.**
  - A pencil beside the dates in the budget drawer.
  - A Dates column in the Budgets tree and flat pivot (query rows now carry `startDate` and `endDate`); a click opens the same dialog.
  - A parent's "not split" row (ADR-059) refuses, because the row is a remainder, not the budget.
  - While a change waits, the drawer shows it as pending.
- Every write is one audit event and one outbox row:
  - `envelope.dates_changed` when the change applies at once;
  - `envelope.dates_requested` when it waits, then approval's own events once decided;
  - outbox `budget.changed` with kind `dates`, whose `envelopeIds` the roll-up and search workers read.

### Other dated records (R9-003)

The same pencil, a shared `DateRangeEditor`, edits every other record's dates where it is shown. Each record keeps its own rules:

- **Targets:** `PATCH /targets/:id/dates` (new). A target's values carry its versions and approvals; its dates are the period it covers, so they change in place, audited (`target.dates_changed`, outbox `target.changed` kind `dates`). An envelope's target stays inside the envelope's dates.
- **Experiments:** the existing `PATCH /experiments/:id`, while planned or running. A concluded or abandoned experiment keeps its dates.
- **Fiscal periods:** the existing `PATCH /periods/:id`, for people with `registry.manage`, until the period has a closure (ADR-041).
- **Manual entry batches:** the existing `PATCH /manual-entries/:id`, while the batch is a draft. Its rows must still fall inside the period (ADR-034).
- **Alert snoozes:** a snoozed alert's date picker re-snoozes it until the end of the chosen day.

Not editable, on purpose:
- **Snapshots:** they keep the moment they were taken; a snapshot's date is the fact it records, not a plan.
- **Approval due dates:** they come from the policy's timeouts.

## Consequences
- The timeline's bars cannot be dragged yet; the plan's epic 2.5 does that through this endpoint.

## Addendum (W3-5, 2026-10-05): the approval checks the dates again; every line is held

Audit I-17: the dates were checked when the change was requested and written when it was approved, possibly days later, without a second look. Two interleavings broke the tree:
- the budget was moved under a parent that runs a shorter range, so the approval put it outside its parent;
- a trimmed child that was never approved was re-dated (which applies at once), and the approval silently reverted it.

Only budgets that received a new version were held, and nothing refused a move of a held budget.

- **Every line is held.** All budgets a date change moves are `PENDING` until it is decided, with or without a version of their own. A budget in an open structural request (split, merge, end, reintroduce, dates) cannot be moved, re-dated (`POST /dates` or `PATCH` dates), ended or reintroduced: 409 "Waiting for approval: request <id>". Draft amount edits are another kind of change and stay allowed; a draft under approval is still frozen.
- **The request records what it saw.** Each line of the `dates` payload carries the budget's `parentId` and `rowVersion` at request time. Requests made earlier lack them; their range checks still run.
- **The approval re-checks under the row locks, before writing anything.** Every line is locked by id, then checked:
  - same parent and row version;
  - not archived, closed or ended;
  - the new dates still fit the parent's (its new dates when the parent is a line too);
  - every child still fits.
- **A mismatch sends the request back.** It goes to `CHANGES_REQUESTED`, committed, and the approver gets a 409 "The budget changed since the request was made; re-request the dates", with `{ envelopeId, reason }`. The reason is one of `moved`, `changed`, `archived`, `locked`, `ended`, `outside_parent`, `child_outside` or `missing`. It is recorded on a blocking thread on the request, and in one `approval.request_changes` audit row and one outbox row, whose `stale` field holds the reason.
- **Any decision gives held budgets their status back:** `APPROVED` with an approved amount, else `DRAFT`. On approval, a line without a version of its own (a budget never approved) gets its own `envelope.dates_changed` audit row and `budget.changed` outbox row, so every line is announced once.
