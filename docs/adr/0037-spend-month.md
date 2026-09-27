# ADR-037: Monthly spend totals for the planner's actual

## Status

Accepted.

## Context

The T-034 load job at spec scale (100k leaves, 24.4M spend facts) sends Explorer queries past the API's 15 s transaction timeout. Profiling a 100-shard copy (19.5k leaves) locally showed the cause: `actual` is a correlated sum over `spend_fact` for each envelope. That is about 240 daily rows per leaf per year, across 12 monthly partitions, and it took ~10 of the root tree query's 16 s.

## Decision

- **`spend_month`** holds `(workspace_id, envelope_id, month) → amount_reporting, fact_count`. It is SQL-owned, has RLS and is readable by `budget_mcp`. Unmatched facts (no envelope) are left out, as `actual` leaves them out.
- **It is a sum of facts, not a stored KPI.** KPIs (CPA, ROAS, pace, …) are still derived at query time.
- **Kept exact by statement-level triggers** on `spend_fact` (INSERT, UPDATE, DELETE, using transition tables). The triggers apply signed deltas and remove months left with no facts. This covers every write path without touching them: ingest, manual entry, demo data and its purge, re-matching an unmatched fact, and a date moved across partitions.
- **The planner** (`spendSql`) splits the period with `monthSplit`:
  - whole months are summed from `spend_month`;
  - the partial days at each edge are summed from `spend_fact`.
  A month-aligned period (year, quarter, month) reads no daily rows. The spend side of a metric (the numerator of CPA, for example) uses the same split.
- **The migration backfills** from the facts already loaded.

## Consequences

- **Measured locally** at 19.5k leaves (untuned Postgres, 128 MB shared buffers):

  | scenario | before | after |
  |---|---|---|
  | tree_root | 16.4 s | 1.0 s |
  | pivot | — | 1.2 s |
  | tree_country | — | 0.72 s |
  | tree_deep | — | 0.43 s |
  | leaf_page | — | 0.16 s |
  | shard_filter | — | 0.06 s |

- **Not enough alone for the < 400 ms target at 100k leaves.** Queries over all leaves still do per-leaf work (budget lookup, dimension join, the monthly sum) of roughly 0.05 ms each. Broad queries need a set-based path or the roll-up cache; that is a separate decision.
- **Deep filters:** the 400 ms of `tree_deep` goes to chained dimension filters that Postgres estimates at one row each. That is also a separate fix.
- **Write cost:** each statement that writes `spend_fact` also upserts its months, one grouped upsert per statement.
- **Tests:** `query-planner/src/spend-month.test.ts` checks the triggers through insert, re-match, cross-partition move and delete. A property test checks that `actual` equals a direct sum of `spend_fact` for random periods.

## Follow-up (2026-09-27): large deletes

The first version removed emptied months by joining `spend_month` to the statement's transition table. Transition tables have no statistics, so the load job's cleanup delete of about 24M facts ran for hours, and 4.7M locally ran for more than 85 minutes. Migration `20260928020000_spend_month_delete` finds emptied months through a partial index on `(workspace_id) WHERE fact_count = 0`, which normally holds no rows. The same 4.7M-row delete now takes about 25 s.
