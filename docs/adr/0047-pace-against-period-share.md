# ADR-047: Pace compares spend with the budget's share of the period

## Status

Accepted. This supersedes the pace formula in spec §6 and ADR-038.

## Context

Product feedback (2026-09-28): "what does pace 0.15 for everything mean?"

Pace was `(actual / budget) / elapsed`, where:

- `budget` was the envelope's full approved amount;
- `actual` and `elapsed` belonged to the query period.

Budgets opens on "This quarter". A year-long budget with a quarter's spend on plan therefore read about 0.25, and near the end of the quarter the whole workspace read 0.15.

## Decision

- **A new measure, `budget_in_period`:** the budget × the days the envelope overlaps the period ÷ the envelope's days.
- **Pace** is `(actual / budget_in_period) / elapsed`. For a group, it's `Σactual / Σbudget_in_period / elapsed` (sums, never averages).
- **Where it applies:**
  - the Postgres planner;
  - the BigQuery dialect;
  - `groupRatios` (the roll-up cache and `/tree`, which store `budget_in_period` unrounded so that refreshes equal rebuilds);
  - the Overview heatmap and pacing rules, which read the planner.
- **Old cache entries:** a cached tree without `budget_in_period` counts as not cached. `/tree` falls back to `/query`, and the roll-up worker fully rebuilds a template and period whose root is missing or old, instead of refreshing it.
- **Default period:** Budgets opens on the fiscal year, as the Overview does.
- **Unchanged:** `budget`, `spend_to_date_pct`, `projected_close_pct` and the variance measures stay against the full budget ("of the budget").

## Consequences

- For year-long budgets over the fiscal year, `budget_in_period` equals `budget`, so pace is unchanged there.
- The proration is by days. Using the version's monthly phasing, when it has one, is a follow-up.
