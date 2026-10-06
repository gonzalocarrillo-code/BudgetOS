# ADR-086: Experiments on fact scopes (campaign vs campaign), no-data days, editable dates, permanent delete

## Status

Accepted (EX-2).

## Context

Experiments (T-038, spec §25) compared two sides through the planner over **envelopes**: a filter on
a dimension only facts carry (e.g. `campaign`) selected no budget and scoped nothing. The read-out was
one total over the window, dates froze at conclusion, and an experiment could not be removed. The
owner asked for campaign vs campaign on true spend / KPI data, per-day results where a day without
data reads "no data" (never 0), full control over dates, and permanent deletion.

## Decision

1. **Side scope kind.** `experiment.test_scope_kind` / `control_scope_kind` (`'envelope' | 'fact'`,
   default `'envelope'`; expand-only migration `20261020020000_experiment_scope_kind`). A `fact` side's
   FilterGroup is evaluated on `spend_fact` / `kpi_fact.dimension_values` (dimension predicates only:
   eq, neq, in, nin, is_empty, not_empty, contains/starts_with on code or registry label), independent
   of budgets and of whether a fact is matched. Validated in `@budget/domain` (`isFactScope`).
2. **Planner.** `packages/query-planner/src/compile-fact-scope.ts`: `compileFactSeries` (one row per
   calendar day in [start, min(end, today)]) and `compileFactTotals` (sums over the days with data,
   `days_with_data`, `days_in_window`). Derived metrics from the metric library are computed at query
   time, per day and in total as Σnumerator / Σdenominator; budget-based metrics are refused on facts.
   Superseded facts are excluded (ADR-071); demo facts follow T-5 / ADR-082. Fact sides are cut to the
   caller's envelope read scope (a fact counts only when matched to an envelope inside it) unless the
   caller reads the whole workspace. `compileFactDimensionValues` feeds the campaign picker.
3. **No-data days.** A day with no fact row for a side is `hasData: false` with every value null;
   with data, a metric with no fact row that day is still null (spend without conversions: CPA null).
4. **Envelope sides** keep the planner read-out unchanged and also get the daily series, from the
   facts matched to their live leaves.
5. **Dates** are editable in every status; other fields stay locked once concluded/abandoned (409).
   Moving a CONCLUDED experiment's dates writes the usual audit + outbox and posts a system comment on
   every linked budget. A fact-only experiment may conclude with no linked budget.
6. **Delete.** `DELETE /experiments/{id}` hard-deletes the experiment and its links, removes the
   `experiment` tag from budgets no other experiment tests, keeps every audit row, and writes one
   `experiment.deleted` audit row + one outbox row in the same transaction (search drops the
   document). Route permission `envelope.edit_draft`; the command further requires the experiment's
   owner or a workspace/org admin. Threads posted on budgets at conclusion stay.

## Consequences

- Experiments are the one entity here that is hard-deleted; the audit trail is its only record.
- The web compares campaigns found in spend data in the window, with a plain-SVG daily chart (no new
  dependency) that breaks its line on no-data days, and a day table that says "No data".
