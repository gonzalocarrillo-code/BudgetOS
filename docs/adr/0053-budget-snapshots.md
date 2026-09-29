# ADR-053: Budget snapshots saved by hand

## Status

Accepted (product feedback round 7, docs/BUDGET_HISTORY_PLAN.md revision 2). Phase E1 (H-001, H-002, H-005) added snapshots. Phase E2 (H-011, H-012) added ending and reintroducing a budget.

## Context

The product owner wants to tell three budgets apart:

- the budget agreed at the start of a period;
- the working budget people keep editing;
- the budget as it stood at close.

They want to see how much budgets move, and to ask about it through MCP. Snapshots are saved by hand. The owner said explicitly that nothing should be captured automatically when a quarter starts or ends.

Amounts already have history, because `envelope_version` is immutable and the planner's `asOf` reads the version approved at a time. Structure has none: parent, name, granularities and dates are edited in place on `envelope`. A snapshot therefore can't be a timestamp alone.

## Decision

- **A snapshot is a row plus frozen rows.** The snapshot row is `budget_baseline`, with a name, a kind (`plan`, `close` or `other`), a scope, an optional period key and the `as_of` time. Each budget in scope gets a `budget_baseline_row`. It holds the version then approved, its amount, reporting amount and currency, and the parent, name, granularities, dates and leaf flag as they were. Both tables have `workspace_id` and the tenant RLS policy. The read-only MCP role can select from them.
- **The code says `baseline`; the product says "Snapshot".**
- **Scope** is one of:
  - the whole workspace, saved by finance or admins;
  - the budgets a filter matches, resolved through the planner, also finance or admins;
  - one budget's subtree, saved by anyone who may edit that budget.
- **Snapshots are never deleted.** Rename, re-kind, add a note, archive and restore are the only changes. Each change writes one `audit_event` and one outbox row (`baseline.saved`, `baseline.changed`).
- **The change report** compares a snapshot with now, or with a later snapshot. It is computed at request time from the frozen rows and the current versions. Nothing derived is stored. The totals sum only root rows, the rows whose parent is outside the snapshot, so a parent and its children are not counted twice. Per-granularity movement uses leaves.
- **Version history shows where a version was saved.** Each version in an envelope's version list carries the snapshots that captured it.
- **The workspace purge deletes both tables** with the other tenant rows (ADR-052).

## Decision: ending and reintroducing a budget (Phase E2)

- **Ending is a budget change.** `POST /envelopes/:id/end` writes a version with the final amount and routes it through the approval policy as one `bulk_change` of kind `end`, as split does. The request's facts carry the real change in amount, so a policy judges an end like any other change. An admin's end applies at once (ADR-048).
- **The end applies on approval.** `bulk_change.payload` carries the end date and reason. When the request is approved, `finalizeBulk` approves the versions and then sets `end_date`, `ended_at`, `ended_by` and `ended_reason`. A rejected or withdrawn end leaves the budget as it was.
- **An ended budget is read-only.** Every write through `lockForWrite` returns `423 LOCKED`, and nothing can be added under an ended budget or moved into one. Its status stays `APPROVED`, so the planner, roll-ups and pacing read it unchanged. The UI shows it as "Ended".
- **A parent with running children cannot end** (decision E6).
- **Reintroducing creates a successor.** `POST /envelopes/:id/reintroduce`, or `successor` inside the end, creates a new budget under the same parent, with the same granularities, currency and owner. It gets new dates, which start after the old end, and a new amount, and it has `envelope_lineage` kind `continues`. It goes through the policy as a `reintroduce` bulk change, or inside the end's request. Versions that give amount back are approved before new ones, so a successor can reuse what the ended budget released under the parent's cap.
- **The dialog proposes spend as the final amount.** `GET /envelopes/:id/spend?through=` returns spend up to the last day, which the End dialog proposes as the final amount (decision E2).

## Decision: comparing inside /query (Phase E3)

- **`QueryRequest.compareTo`** is either `{ baselineId }`, a snapshot's frozen rows, or `{ asOf }`, the versions approved at an instant, which is the same rule as `asOf`.
- **Three measures** come with it: `budget_baseline`, `budget_change_abs` and `budget_change_pct`. They are derived per envelope in the planner's measures CTE and never stored.
  - The change is now minus then.
  - A budget the snapshot does not hold has no baseline, and its whole budget counts as change, because it is new.
  - A group's change % is its total change over its total baseline, never an average of percentages.
- These measures work in flat, grouped, subtree and totals queries, and in sort, filter and keyset paging.
- **The compare measures need `compareTo`.** The planner refuses them without it. A query with `compareTo` stays on Postgres, not the warehouse, and the roll-up cache (`/tree`) does not accept them.
- **A subtree snapshot compared with the whole workspace** shows every budget outside it as new. Screens that compare with a subtree snapshot filter to that subtree, which comes in Phase E4.

## Decision: the screens (Phase E4)

- **Budgets.** "Compare to" picks a snapshot, which is kept in the URL as `compareTo`. The columns become Snapshot · Now · Change · Change % · Actual, and the totals row compares too. A banner names the snapshot, and says so when it holds only one budget's subtree. "Save snapshot" opens the save dialog, with a name, a kind, the scope (the workspace, the current filter or the selected budget), a period and a note.
- **Drawer.** While Budgets compares, Details says what the snapshot held for the budget and what it holds now. History lists the snapshots that hold the budget, and offers "Save a snapshot of this budget". The list route takes `?envelopeId=` and returns each snapshot's frozen row for that budget.
- **Overview.** A "Since the plan" tile shows the change since the latest plan snapshot, from the change report (decision E4). It opens Budgets comparing with that snapshot, and people can hide it like the other tiles.
- **Closures.** A period's report offers "Save as close", a snapshot with kind `close` and the period key. It shows "Plan → close" once the period has both.
- **Settings › Fiscal calendar › Snapshots** lists every snapshot. People can rename, archive and restore them, and open one in Budgets. Snapshots are never deleted.
- **Ended budgets** read `ENDED` in the planner's flat rows, and the grid shows "Ended". Filters still see status `APPROVED`.

## Decision: MCP and the golden workspace (Phase E5)

- **Two read-only MCP tools.**
  - `list_baselines` lists snapshots. With `envelopeId`, it lists the ones that hold that budget and what each kept.
  - `compare_budgets` is the change report, against now or against a later snapshot.
- **`query_budgets` gains `compareTo`**, and its description says so, along with `asOf`. The tools call the API's read barrel only. For that, the snapshot module is split into `queries/` and `commands/`, and the envelope read takes its FX lookup from `envelopes/fx.ts`, not from `commands/`. The MCP import guard enforces both.
- **The golden workspace** (`GOLDEN_HISTORY`):
  - Finance saves the plan as it stood on 1 February, after round 1 and before the re-plans.
  - After the split, an admin ends one FY2026 leaf on its own last day with its approved amount.
  - Its FY2027 successor gets USD 750, which fits in the parent's room.
  - FY2026 totals are unchanged. The envelope count gains 1, and the approved-version and search counts change with it.

## Consequences

- A snapshot of a large workspace copies one row per budget. At the planned sizes of up to 50,000 budgets, that is one INSERT…SELECT inside the request transaction.
- Moves, renames and granularity changes made after a snapshot don't change it. That is the point, and it is also why the report can show a budget as moved.
