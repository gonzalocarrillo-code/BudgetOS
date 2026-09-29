# ADR-059: Pivots and trees count what each budget holds itself

## Status

Accepted (product feedback 2026-09-29). Amends ADR-016: roll-up nodes and the Budgets pivot no longer sum only live leaves.

## Context

The owner built FY2026 Media (USD 150M) → Paid Search (100M) and Paid Social (50M) → LATAM → Argentina → Consumer, and only split part of it. Budget structure (ADR-050) showed 150M. The Pivot showed 25M: it summed live leaves only (ADR-016), and the 125M that parents had not split into children yet was in no leaf. The same gap applied to every grouping and to the hierarchy-template tree.

## Decision

- **Each live budget holds its amount less its live children's amounts in the period.** A leaf holds all of it; a fully split parent holds nothing; spend booked on a parent is its own. The planner's `unallocated: true` computes this per envelope, for `budget`, `budget_in_period` and the snapshot baseline. Everything derived from those (remaining, pace, variance, change) follows. Over any set of budgets the holdings add up to the budgets at the top of that set, so every grouping of the pivot, the template tree and the totals row equals the top-level budgets that Budget structure shows.
- **Holdings belong to the budget, not to the filter.** A child outside the filter still reduces its parent's holding. Filtering a branch therefore reads that branch's own amount (Channel = Paid Search reads 100M), and a query scoped to `envelopeIds` (the roll-up refresh) still subtracts every child.
- **Rows.** A parent with a remainder is a flat row of its own, labelled "Paid Search · not split". A parent that holds nothing and has no spend of its own is not a row. A remainder row cannot be edited or pasted into, because it shows the remainder, not the budget's amount; the budget is edited from its drawer or in Budget structure. `leaf_count` still counts leaves only.
- **An over-allocated parent** (`allow_over_allocation`) holds a negative remainder, so the totals still equal the top-level budgets.
- **The roll-up cache uses the same rule.** A change to a budget also refreshes its parent's node. A move rebuilds the templates, because its event names only the new parent. Node sums are exact (60 digits), so a refresh and a rebuild agree to the last digit. The cache needs one rebuild when this ships (`rebuildWorkspace`, or any registry change).
- **Unchanged:** closure reports (T-024) keep live leaves, like every closure already published; Overview's cells keep live leaves under "split into the budgets below"; MCP and the timeline are unchanged. `unallocated` runs on Postgres only: `bigQuerySupported` refuses it until the BigQuery compiler learns it.

## Consequences

- The Budgets pivot, the template tree and Budget structure show the same totals.
- A grouping shows unsplit money where it sits. By Region, the 90M Paid Search has not split is under "No region", because it has no region yet.
- A pivot over months that were pruned from Postgres (ADR-054) is refused rather than routed to BigQuery, until the BigQuery compiler supports holdings.
