# ADR-076: Closures record and show their budget basis

## Status

Accepted (owner decision D-1, 2026-10-05; audit T-12).

## Context

ADR-059 moved the Budgets pivot, the hierarchy-template tree and Budget structure to "holdings": each
live budget counts for its amount less its live children's, so a partially-split parent's unsplit
remainder shows up somewhere instead of vanishing. ADR-059 explicitly left closure reports (T-024)
on the older basis, live leaves only, "like every closure already published" — new closures keep
summing live leaves, not holdings.

The stack audit (T-12) flagged the result: a workspace can show two different "budget" totals for
the same period — one on Budgets/the tree (holdings), one on a closure's frozen report (live
leaves) — with nothing on screen explaining why they differ. Nothing is wrong (both figures are
real, intentional sums of real rows), but a reader has no way to know a closure's figure is the
older basis without reading ADR-059.

## Decision

- **Closures keep live leaves as their budget basis.** We do not switch `close-period.ts` to call
  `templateNodes` with `unallocated: true`. A closure already published is a frozen report; readers
  need its figure to mean the same thing as the year before it, and a change in basis would make a
  multi-period comparison (the whole point of audit trails) compare two different quantities under
  one label.
- **The basis is now recorded, not just implied.** `startClose` (transaction 1 of the two-phase
  close, `close-period.ts`) writes `variance_summary.basis = { budget: "live_leaves", note: "…" }`
  at close time, alongside the totals it already computes. `ClosureBasis` is a new zod schema in
  `@budget/domain` (`closures.ts`); `ClosureView.basis` is optional, because closures written before
  this field existed have no `basis` key in their stored JSON and must keep rendering.
  `closureView()` reads it out of the stored `variance_summary` defensively (`ClosureBasis.safeParse`),
  so a malformed or absent value is dropped rather than surfaced or thrown.
- **The web closures page shows a one-line note**, not a banner: next to the Budget figure on a
  closure's report, `closures.basisNote` renders the stored `note` when `basis` is present, and
  nothing when it is absent (an older closure).

### Rejected alternative

**Switch new closures to the holdings basis.** Considered and rejected for now: a closure is a
frozen, audited artifact compared period over period (variance, trend, "vs last close"). Changing
what a future closure's Budget column means, while past closures keep the old meaning, would make
that comparison silently wrong — the opposite of what a closure is for. If Budgets/tree and closures
need to agree, that is a separate, larger change (teaching the BigQuery-bound planner path holdings,
per ADR-059's own "Unchanged" note on `bigQuerySupported`) and needs its own ADR, not a side effect
of a labeling fix.

## Consequences

- No change to closure numbers, old or new; only a new field describing what they already were.
- A later decision to move closures to holdings is still open, and is now cheaper to make
  correctly: it would be gated on `basis` so a reader (and the planner) can always tell which rule
  produced a given closure's figure, instead of only inferring it from the close date.
