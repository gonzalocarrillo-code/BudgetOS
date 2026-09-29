# ADR-061: Timeline bars drag to change a budget's dates

## Status

Accepted (product feedback 2026-09-29; plan epic 2.5). Builds on ADR-060.

## Context

The timeline (T-037, `@budget/timeline` on the SVAR React Gantt MIT core) was read-only. The owner asked for its bars to be draggable to change dates. SVAR's core can already drag a bar and resize its ends, but with `readonly` off it also allows adding, deleting, copying, indenting and linking tasks, dragging progress, and editing cells.

## Decision

- **Only a budget's bar moves.** A bar moves when all of these hold:
  - it is an envelope bar;
  - the caller may edit budgets (`envelope.edit_draft`);
  - the timeline is not showing a past as-of;
  - the budget is not ended, locked, archived or waiting for approval.
- **Everything else SVAR could edit is refused** by intercepting its actions:
  - `add-task`, `delete-task`, `copy-task`, `move-task`, `indent-task`;
  - the link actions and `show-editor`;
  - any `update-task` that changes more than `start` and `end`.
  - Progress and link handles stay hidden, as before.
- **A drop proposes dates; it applies nothing.**
  - The adapter reads the bar's new start and end (SVAR's end is exclusive) and hands them to the caller with a `revert`.
  - The Budgets timeline opens Change dates (ADR-060) with those dates, so the same preview, child trimming and approval rules apply.
  - Cancelling puts the bar back. A change that waits for approval also puts it back, until approval. A change that applies at once redraws the bar from the refetch.
- **The dates snap to SVAR's cell unit.** That is a day, week, month or quarter, depending on the zoom. The dialog's inputs take any day.
- A movable bar shows a grab cursor and, on hover, a handle at each end. SVAR resizes from the outer 40px of a wide bar.

## Consequences

- Experiments and targets on the timeline still don't move; their dates are edited on their own pages (ADR-060).
- A bar that spans the whole chart can only shrink, or move once it has been shortened, because SVAR keeps bars inside the chart range.
