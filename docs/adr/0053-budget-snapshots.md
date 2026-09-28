# ADR-053: Budget snapshots saved by hand

## Status

Accepted (product feedback round 7, docs/BUDGET_HISTORY_PLAN.md revision 2, tasks H-001, H-002 and H-005). Ending and reintroducing a budget (H-011, H-012) will extend this ADR in Phase E2.

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

## Consequences

- A snapshot of a large workspace copies one row per budget. At the planned sizes of up to 50,000 budgets, that is one INSERT…SELECT inside the request transaction.
- Moves, renames and granularity changes made after a snapshot don't change it. That is the point, and it is also why the report can show a budget as moved.
- Comparing to a snapshot inside `/query` is a planner measure, which comes in Phase E3 (H-004).
