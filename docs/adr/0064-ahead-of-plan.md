# ADR-064: Ahead of plan, pace in money

## Status

Accepted.

## Context

The Overview ranked "most over pace" and "most under pace" by the pace index, a ratio. Ranked by a ratio, a USD 5,000 budget at 1.05 outranks a USD 100,000 budget at 1.04, and budgets with no spend lead the under list. The golden showed this: the top five over pace were USD 4.5k–6.9k budgets at 1.04–1.06. Money at stake played no part (`docs/HOME_OVERVIEW_PLAN.md`, finding O-1, decision G6).

## Decision

A derived measure, `ahead_of_plan_abs`:

```
ahead_of_plan_abs = actual − budget_in_period × elapsed
```

- It is the pace comparison in currency: positive means spend ahead of the budget's share of the time gone, negative means behind.
- `elapsed` is the planner's share of the period gone, so it follows `elapsedThrough` (ADR-062) on Home and the Overview.
- Spend with no approved budget counts as all ahead (its budget share is 0).
- Groups and totals are sums, since elapsed is the same for every row. BigQuery computes `SUM(actual) − SUM(budget_in_period) × @elapsed`, the same number.
- It is a money measure: rounded to cents in responses, sortable and filterable like any other.
- It is computed at query time and never stored (AGENTS §4). The roll-up cache and `/tree` do not offer it.

## Consequences

- The Overview's "Needs attention" list ranks by the size of this number (HO-010), and Budgets can sort by it.
- The measure uses day-proration like pace (ADR-047). A version's monthly phasing is still not used; that follow-up would change both.
